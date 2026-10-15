// Smoke test of the browser pipeline in Node (CPU backend, small subset):
// dataset zip -> train a few epochs -> export int8 tflite -> dump float predictions so
// compare_tflite.py can check the export against the trained model.
//   node tools/trainer-web/scripts/node-check.mjs <dataset.zip> <outdir> [nTrain=1500] [epochs=2]
import fs from "node:fs";
import path from "node:path";
import jpeg from "jpeg-js";
import * as tf from "@tensorflow/tfjs-core";
import "@tensorflow/tfjs-backend-cpu";
import { loadDatasetZip, PIX } from "../src/dataset.js";
import { buildModel, train, predict, modelSpec } from "../src/model.js";
import { exportTflite } from "../src/tflite/export.js";

const [zipPath, outDir, nTrainArg, epochsArg] = process.argv.slice(2);
const nTrain = +(nTrainArg || 1500), epochs = +(epochsArg || 2);
fs.mkdirSync(outDir, { recursive: true });
await tf.setBackend("cpu");

const t0 = Date.now();
const decode = async (b) => { const im = jpeg.decode(b, { useTArray: true, formatAsRGBA: true }); return im; };
const ds = await loadDatasetZip(new Uint8Array(fs.readFileSync(zipPath)), decode);
console.log(`loaded ${ds.rows.length} crops in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

const all = ds.rows.map((r, i) => [r, i]);
const pick = (f, n) => all.filter(([r]) => f(r)).map(([, i]) => i).sort(() => Math.random() - 0.5).slice(0, n);
const trainIdx = pick((r) => r.split === "train", nTrain);
const valIdx = pick((r) => r.split === "train" && !trainIdx.includes(0), 200);
const testIdx = pick((r) => r.split === "test" && r.src !== "public", 800);

const model = buildModel();
const t1 = Date.now();
await train(model, { X: ds.X, Y: ds.Y, trainIdx, valIdx }, {
  epochs, batch: 64,
  onEpoch: (e) => console.log(`epoch ${e.epoch + 1}/${e.epochs} loss ${e.loss.toFixed(3)} acc ${e.acc.toFixed(3)} val_loss ${e.valLoss.toFixed(3)} val_acc ${e.valAcc.toFixed(3)} ${e.seconds.toFixed(1)} s`),
});
console.log(`train ${((Date.now() - t1) / 1000).toFixed(1)} s`);

const calib = trainIdx.slice(0, 200).map((i) => Float32Array.from(ds.X.subarray(i * PIX, (i + 1) * PIX)));
const { bytes } = exportTflite(modelSpec(model), calib, { description: "trainer-web node-check" });
fs.writeFileSync(path.join(outDir, "js_q.tflite"), bytes);
const probs = await predict(model, ds.X, testIdx);
fs.writeFileSync(path.join(outDir, "test.json"), JSON.stringify({
  X: testIdx.map((i) => Array.from(ds.X.subarray(i * PIX, (i + 1) * PIX))),
  Y: testIdx.map((i) => Array.from(ds.Y.subarray(i * 10, i * 10 + 10))),
  probs: Array.from({ length: testIdx.length }, (_, k) => Array.from(probs.subarray(k * 10, k * 10 + 10))),
}));
console.log(`exported ${bytes.length} bytes -> ${outDir}`);
