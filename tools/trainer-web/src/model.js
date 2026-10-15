// Digit-wheel model (DoubleHyprid10 head: 10-way softmax with soft targets) and its
// training loop. Same recipe as tools/meter-train/train.py, with BatchNorm placed before
// the activation so src/tflite/export.js can fold it into the convolutions.
// Functional tf.* ops only: chained tensor methods are not registered in modular tfjs-core.
import * as tf from "@tensorflow/tfjs-core";
import * as tfl from "@tensorflow/tfjs-layers";
import { IN_H, IN_W, IN_C, PIX } from "./dataset.js";

export const INPUT_SCALE = 1 / 255;
export const ALPHA = 0.3;

export function buildModel({ filters = [24, 48, 48], dense = [128, 64], dropout = 0.25 } = {}) {
  const m = tfl.sequential();
  filters.forEach((n, i) => {
    m.add(tfl.layers.conv2d({ filters: n, kernelSize: 3, padding: "same",
      ...(i === 0 ? { inputShape: [IN_H, IN_W, IN_C] } : {}) }));
    m.add(tfl.layers.batchNormalization({ epsilon: 1e-3 }));
    m.add(tfl.layers.leakyReLU({ alpha: ALPHA }));
    m.add(tfl.layers.maxPooling2d({ poolSize: 2 }));
  });
  m.add(tfl.layers.flatten());
  dense.forEach((n) => {
    m.add(tfl.layers.dropout({ rate: dropout }));
    m.add(tfl.layers.dense({ units: n }));
    m.add(tfl.layers.leakyReLU({ alpha: ALPHA }));
  });
  m.add(tfl.layers.dense({ units: 10, activation: "softmax" }));
  return m;
}

export { countMacs } from "./arch.js";

/** Weights in the layout src/tflite/export.js expects. */
export function modelSpec(model) {
  const convs = [], denses = [];
  const ls = model.layers;
  ls.forEach((l, i) => {
    const cls = l.getClassName();
    if (cls === "Conv2D") {
      const [k, b] = l.getWeights().map((t) => t.dataSync().slice());
      const bn = ls[i + 1];
      const [gamma, beta, mean, variance] = bn.getWeights().map((t) => t.dataSync().slice());
      convs.push({ kernel: k, bias: b, bn: { gamma, beta, mean, variance, eps: bn.getConfig().epsilon } });
    } else if (cls === "Dense") {
      const [k, b] = l.getWeights().map((t) => t.dataSync().slice());
      denses.push({ kernel: k, bias: b });
    }
  });
  return { inputShape: [IN_H, IN_W, IN_C], inputScale: INPUT_SCALE, alpha: ALPHA, convs, denses };
}

// ---- augmentation (label preserving, no flips), x: [n,32,20,3] float 0..255 ----
let BLUR = null; // created on first use, after a backend is ready

export function augment(x) {
  BLUR ||= tf.tidy(() => tf.keep(tf.tile(tf.reshape(
    tf.div(tf.tensor2d([[1, 2, 1], [2, 4, 2], [1, 2, 1]]), 16), [3, 3, 1, 1]), [1, 1, 3, 1])));
  return tf.tidy(() => {
    const n = x.shape[0];
    // shift +-2 px with mirrored border: exact integer crops via cropAndResize
    const padded = tf.mirrorPad(x, [[0, 0], [2, 2], [2, 2], [0, 0]], "symmetric");
    const PH = IN_H + 4, PW = IN_W + 4;
    const boxes = [];
    for (let i = 0; i < n; i++) {
      const dy = Math.floor(Math.random() * 5), dx = Math.floor(Math.random() * 5);
      boxes.push([dy / (PH - 1), dx / (PW - 1), (dy + IN_H - 1) / (PH - 1), (dx + IN_W - 1) / (PW - 1)]);
    }
    let y = tf.image.cropAndResize(padded, tf.tensor2d(boxes), tf.range(0, n, 1, "int32"), [IN_H, IN_W], "bilinear");
    // slight blur on 30% of the crops
    const blurred = tf.depthwiseConv2d(y, BLUR, 1, "same");
    const doBlur = tf.less(tf.randomUniform([n, 1, 1, 1]), 0.3);
    y = tf.where(tf.tile(doBlur, [1, IN_H, IN_W, IN_C]), blurred, y);
    // contrast, brightness, per-channel gain, noise
    const mean = tf.mean(y, [1, 2, 3], true);
    y = tf.add(tf.mul(tf.sub(y, mean), tf.randomUniform([n, 1, 1, 1], 0.7, 1.3)), mean);
    y = tf.add(y, tf.randomUniform([n, 1, 1, 1], -30, 30));
    y = tf.mul(y, tf.randomUniform([n, 1, 1, 3], 0.9, 1.1));
    y = tf.add(y, tf.randomNormal(y.shape, 0, 3));
    return tf.clipByValue(y, 0, 255);
  });
}

function batchTensor(X, idx) {
  const buf = new Float32Array(idx.length * PIX);
  idx.forEach((r, k) => { for (let i = 0; i < PIX; i++) buf[k * PIX + i] = X[r * PIX + i]; });
  return tf.tensor4d(buf, [idx.length, IN_H, IN_W, IN_C]);
}
function targetTensor(Y, idx) {
  const buf = new Float32Array(idx.length * 10);
  idx.forEach((r, k) => buf.set(Y.subarray(r * 10, r * 10 + 10), k * 10));
  return tf.tensor2d(buf, [idx.length, 10]);
}

/** Softmax probabilities for rows idx of X (raw uint8 crops). Returns Float32Array(n*10). */
export async function predict(model, X, idx, chunk = 512) {
  const out = new Float32Array(idx.length * 10);
  for (let s = 0; s < idx.length; s += chunk) {
    const part = idx.slice(s, s + chunk);
    const p = tf.tidy(() => model.predict(tf.mul(batchTensor(X, part), INPUT_SCALE)));
    out.set(await p.data(), s * 10);
    p.dispose();
  }
  return out;
}

// Let queued messages (e.g. "stop") through. MessageChannel is not throttled the way
// setTimeout and requestAnimationFrame are in hidden tabs.
function yieldNow() {
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => { ch.port1.close(); resolve(); };
    ch.port2.postMessage(0);
  });
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

/**
 * Train with Adam + cosine decay; keeps the weights with the lowest validation loss.
 * data: {X, Y, trainIdx, valIdx}; opts: {epochs, batch, lr, onEpoch, onBatch, shouldStop}
 */
export async function train(model, data, opts = {}) {
  const { epochs = 60, batch = 64, lr = 1e-3, onEpoch = () => {}, onBatch = () => {}, shouldStop = () => false } = opts;
  const opt = tf.train.adam(lr);
  model.compile({ optimizer: opt, loss: "categoricalCrossentropy", metrics: ["accuracy"] });
  const steps = Math.ceil(data.trainIdx.length / batch);
  const total = epochs * steps;
  let step = 0, best = { loss: Infinity, epoch: -1, weights: null };
  for (let ep = 0; ep < epochs && !shouldStop(); ep++) {
    const t0 = performance.now();
    const order = shuffle(data.trainIdx.slice());
    let lossSum = 0, accSum = 0;
    for (let s = 0; s < steps && !shouldStop(); s++) {
      opt.learningRate = lr * 0.5 * (1 + Math.cos(Math.PI * step / total));
      const idx = order.slice(s * batch, (s + 1) * batch);
      const x = tf.tidy(() => tf.mul(augment(batchTensor(data.X, idx)), INPUT_SCALE));
      const y = targetTensor(data.Y, idx);
      const [l, a] = await model.trainOnBatch(x, y);
      x.dispose(); y.dispose();
      lossSum += l; accSum += a; step++;
      if (s % 20 === 0) { onBatch(ep, s, steps); await yieldNow(); }
    }
    // validation loss (cross-entropy against soft targets)
    const p = await predict(model, data.X, data.valIdx);
    let vl = 0, vacc = 0;
    data.valIdx.forEach((r, k) => {
      let am = 0;
      for (let c = 0; c < 10; c++) {
        const t = data.Y[r * 10 + c], q = p[k * 10 + c];
        if (t > 0) vl -= t * Math.log(Math.max(q, 1e-7));
        if (q > p[k * 10 + am]) am = c;
      }
      if (data.Y[r * 10 + am] >= 0.5) vacc++;
    });
    vl /= data.valIdx.length; vacc /= data.valIdx.length;
    const improved = vl < best.loss;
    if (improved) {
      best.weights?.forEach((w) => w.dispose());
      best = { loss: vl, epoch: ep, weights: model.getWeights().map((w) => w.clone()) };
    }
    onEpoch({ epoch: ep, epochs, loss: lossSum / steps, acc: accSum / steps, valLoss: vl, valAcc: vacc,
      seconds: (performance.now() - t0) / 1000, improved });
  }
  if (best.weights) { model.setWeights(best.weights); best.weights.forEach((w) => w.dispose()); }
  return { bestEpoch: best.epoch, bestValLoss: best.loss };
}
