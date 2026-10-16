// Step 4: training in the Web Worker (workers/train.worker.js keeps going in a background tab),
// then the comparison with the installed model and the int8 export.
import { markRaw, reactive } from "vue";
import * as store from "@/services/db.js";
import { buildTrainSet, compareOnTest } from "@/lib/trainset.js";
import { MIN_COMPARE } from "@/lib/readiness.js";
import { t, N_ } from "@/i18n/index.js";
import { app, say, setPill, onStop } from "@/stores/app.js";
import { data } from "@/stores/project.js";
import { num, parseSize } from "@/utils/format.js";
import TrainWorker from "@/workers/train.worker.js?worker&inline";

export const train = reactive({
  size: "24,48,48|128,64", epochs: 60, batch: 64, lr: 0.001,
  useUnconfirmed: false,
  finalAll: true,     // then train the model to install on all images, the test images included
  bar: 0,
  history: [],        // per epoch: { epoch, epochs, loss, valLoss, valAcc, seconds }
  chartEpochs: 1,     // x axis length of the loss chart
  compare: null,      // per wheel: { roi, n, model, dev, devN, modelOnDev, t, tModel }
  model: null,        // { name, bytes, at, acc, compareN, final, trainN, accOnDev, devAcc }
});

// ---------------------------------------------------------------- worker messages
const worker = new TrainWorker();
const waiters = {};
const once = (type) => new Promise((res, rej) => { waiters[type] = { res, rej }; });
let phase = { n: 0, of: 1, label: "" }; // training runs once or twice (comparison, then final)
worker.onmessage = ({ data: m }) => {
  if (m.type === "progress") {
    const frac = (phase.n + (m.epoch + m.step / m.steps) / train.chartEpochs) / phase.of;
    train.bar = frac; app.progress = t("{p}% training", { p: Math.round(frac * 100) });
  } else if (m.type === "epoch") onEpoch(m);
  else if (m.type === "error") {
    const w = Object.values(waiters)[0];
    Object.keys(waiters).forEach((k) => delete waiters[k]);
    w?.rej(new Error(m.message));
  } else if (waiters[m.type]) { const w = waiters[m.type]; delete waiters[m.type]; w.res(m); }
};
onStop(() => worker.postMessage({ type: "stop" }));

/** Starts TensorFlow.js in the worker; resolves with "webgl" or "cpu". */
export async function initWorker() {
  const ready = once("ready");
  worker.postMessage({ type: "init" });
  return (await ready).backend;
}

function onEpoch(e) {
  train.history.push(e);
  say("train", phase.label + t("Epoch {i}/{n}  loss {l}  validation loss {vl}  validation accuracy {va}%  {s} s/epoch  about {m} min left", {
    i: e.epoch + 1, n: e.epochs, l: e.loss.toFixed(3), vl: e.valLoss.toFixed(3), va: (e.valAcc * 100).toFixed(1), s: e.seconds.toFixed(1),
    m: Math.ceil((((e.epochs - e.epoch - 1) + (phase.of - phase.n - 1) * e.epochs) * e.seconds) / 60) }));
}

/** Trains one model in the worker on the given set; resolves with the worker's "trained" message. */
function trainOnce(set, filters, dense, epochs) {
  worker.postMessage({ type: "data", X: set.X, Y: set.Y.slice() }, [set.X.buffer]);
  const done = once("trained");
  train.history = [];
  worker.postMessage({ type: "train", filters, dense, epochs, batch: train.batch || 64, lr: train.lr || 1e-3,
    trainIdx: set.trainIdx, valIdx: set.valIdx, testIdx: set.testIdx });
  return done;
}

export async function runTrain() {
  const includeUnconfirmed = train.useUnconfirmed, final = train.finalAll;
  const set = buildTrainSet(data.crops, data.eff, { includeUnconfirmed });
  if (set.trainIdx.length < 200) throw new Error(t("only {n} usable training images; collect or label more first", { n: set.trainIdx.length }));
  const [filters, dense] = parseSize(train.size);
  const epochs = train.epochs || 60;
  const t0 = performance.now();
  // 1. train without the test images, to compare with the installed model on them
  train.chartEpochs = epochs;
  phase = { n: 0, of: final ? 2 : 1, label: final ? t("Step 1 of 2 (for the comparison): ") : "" };
  say("train", phase.label + t("training on {n} images, testing on {m} from each wheel’s newest days…", { n: num(set.trainIdx.length), m: num(set.testIdx.length) }));
  const res = await trainOnce(set, filters, dense, epochs);
  const compare = compareOnTest(set, res.probs);
  let calib = set.trainIdx.slice(0, 300), kept = res.bestEpoch, trainN = set.trainIdx.length;
  // 2. the model to install: the same recipe on every usable image, the test images included
  if (final && !app.stop) {
    const all = buildTrainSet(data.crops, data.eff, { includeUnconfirmed, all: true });
    phase = { ...phase, n: 1, label: t("Step 2 of 2 (final model, all images): ") };
    say("train", phase.label + t("training on {n} images…", { n: num(all.trainIdx.length) }));
    const res2 = await trainOnce(all, filters, dense, epochs);
    calib = all.trainIdx.slice(0, 300); kept = res2.bestEpoch; trainN = all.trainIdx.length;
  }
  train.bar = 1;
  // export right away (calibration on 300 training images of the set the worker holds now)
  const name = `dig-browser-f${filters[0]}_${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}_q.tflite`;
  const ex = once("exported");
  worker.postMessage({ type: "export", name, calibIdx: calib });
  const { bytes } = await ex;
  const tot = compare.reduce((a, e) => ({ n: a.n + e.n, m: a.m + e.model, d: a.d + e.dev, dn: a.dn + e.devN, md: a.md + e.modelOnDev }),
    { n: 0, m: 0, d: 0, dn: 0, md: 0 });
  // compare with the installed model on the same images, and only with enough of them
  const fair = tot.dn >= MIN_COMPARE;
  const model = { name, bytes, at: Date.now(), acc: tot.n ? tot.m / tot.n : null, compareN: tot.dn, final: final && !app.stop, trainN,
    accOnDev: fair ? tot.md / tot.dn : null, devAcc: fair ? tot.d / tot.dn : null };
  await store.kvSet("lastModel", model);
  train.compare = markRaw(compare);
  train.model = markRaw(model);
  const v = verdictOf(model);
  setPill("train", { better: N_("new model ready"), worse: N_("not better"), unknown: N_("not compared") }[v], { better: "ok", worse: "warn", unknown: "" }[v]);
  say("train", t("Done in {m} min (kept epoch {e}). Model {kb} KB, trained on {n} images", { m: ((performance.now() - t0) / 60000).toFixed(1), e: kept + 1, kb: (bytes.length / 1024).toFixed(0), n: num(trainN) }) +
    (model.final ? t(", the test images included") : "") + ".");
  return model;
}

/** better | worse | unknown (too few test images the device read itself) */
export function verdictOf(m) {
  if (!m || m.devAcc == null) return "unknown";
  return m.accOnDev >= m.devAcc - 0.002 ? "better" : "worse";
}

export async function loadLastModel() {
  const m = await store.kvGet("lastModel");
  train.model = m && markRaw(m);
}
