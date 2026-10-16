// Exporter cross-check, step 2: weights.json + calib.json (from keras_ref.py) -> js_q.tflite
// plus the JS float forward on the test crops for comparison.
//   node tools/trainer-web/scripts/export-from-json.mjs tools/trainer-web/check-out
import fs from "node:fs";
import path from "node:path";
import { exportTflite } from "../src/lib/tflite/export.js";

const dir = process.argv[2] || "check-out";
const w = JSON.parse(fs.readFileSync(path.join(dir, "weights.json"), "utf8"));
const spec = {
  inputShape: w.inputShape, inputScale: w.inputScale, alpha: w.alpha,
  convs: w.convs.map((c) => ({
    kernel: Float32Array.from(c.kernel), bias: Float32Array.from(c.bias),
    bn: { ...c.bn, gamma: Float32Array.from(c.bn.gamma), beta: Float32Array.from(c.bn.beta),
      mean: Float32Array.from(c.bn.mean), variance: Float32Array.from(c.bn.variance) },
  })),
  denses: w.denses.map((d) => ({ kernel: Float32Array.from(d.kernel), bias: Float32Array.from(d.bias) })),
};
const calib = JSON.parse(fs.readFileSync(path.join(dir, "calib.json"), "utf8")).map((a) => Float32Array.from(a));
const t0 = Date.now();
const { bytes } = exportTflite(spec, calib.slice(0, 200), { description: "trainer-web exporter check" });
fs.writeFileSync(path.join(dir, "js_q.tflite"), bytes);
console.log(`js_q.tflite ${bytes.length} bytes in ${Date.now() - t0} ms`);
