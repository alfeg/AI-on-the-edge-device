// Training runs here, off the page's main thread: browsers pause or heavily throttle
// hidden tabs (timers, animation frames), but keep dedicated workers running. WebGL works
// in the worker through OffscreenCanvas.
//
// Messages in:  init | data {X, Y} | train {...} | stop | export {calibIdx, name}
// Messages out: ready {backend} | progress | epoch | trained {bestEpoch, bestValLoss, probs} | exported {bytes} | error
import * as tf from "@tensorflow/tfjs-core";
import "@tensorflow/tfjs-backend-webgl";
import "@tensorflow/tfjs-backend-cpu";
import { buildModel, train, predict, modelSpec } from "./model.js";
import { exportTflite } from "./tflite/export.js";
import { PIX } from "./dataset.js";

let X = null, Y = null, model = null, stop = false;
const post = (m, transfer) => self.postMessage(m, transfer || []);

self.onmessage = async ({ data: m }) => {
  try {
    if (m.type === "init") {
      for (const b of ["webgl", "cpu"]) {
        try { if (await tf.setBackend(b)) break; } catch { /* try next */ }
      }
      await tf.ready();
      post({ type: "ready", backend: tf.getBackend() });
    } else if (m.type === "data") {
      X = m.X; Y = m.Y;
    } else if (m.type === "stop") {
      stop = true;
    } else if (m.type === "train") {
      stop = false;
      model?.dispose();
      model = buildModel({ filters: m.filters, dense: m.dense });
      const res = await train(model, { X, Y, trainIdx: m.trainIdx, valIdx: m.valIdx }, {
        epochs: m.epochs, batch: m.batch, lr: m.lr,
        shouldStop: () => stop,
        onBatch: (ep, s, steps) => post({ type: "progress", epoch: ep, step: s, steps }),
        onEpoch: (e) => post({ type: "epoch", ...e }),
      });
      const probs = m.testIdx.length ? await predict(model, X, m.testIdx) : new Float32Array(0);
      post({ type: "trained", ...res, probs }, [probs.buffer]);
    } else if (m.type === "export") {
      const calib = m.calibIdx.map((i) => Float32Array.from(X.subarray(i * PIX, (i + 1) * PIX)));
      const { bytes } = exportTflite(modelSpec(model), calib, { description: `trainer-web ${m.name}` });
      post({ type: "exported", bytes }, [bytes.buffer]);
    }
  } catch (e) {
    post({ type: "error", stage: m.type, message: e.message || String(e) });
  }
};
