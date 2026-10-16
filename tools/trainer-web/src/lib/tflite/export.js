// Turn trained float weights into an int8 TFLite model the firmware can run.
//
// Network (what model.js trains):
//   raw RGB 0..255 [1,H,W,3]
//   n x [Conv3x3 same + bias -> BatchNorm -> LeakyReLU -> MaxPool 2x2]
//   Flatten -> m x [Dense -> LeakyReLU] -> Dense -> Softmax (10 = DoubleHyprid10 head)
// The trainer feeds pixels * inputScale; BN and inputScale are folded into the conv
// weights here, so the TFLite graph needs only
//   QUANTIZE CONV_2D LEAKY_RELU MAX_POOL_2D RESHAPE FULLY_CONNECTED SOFTMAX DEQUANTIZE
// (all in CTfLiteClass::MakeStaticResolver). Quantization follows the TFLite int8 spec:
// asymmetric per-tensor activations, symmetric per-channel conv weights, symmetric
// per-tensor FC weights, int32 bias with scale = input_scale * weight_scale, softmax
// output scale 1/256 zero point -128.
import { buildTflite } from "./writer.js";

/**
 * spec = {
 *   inputShape: [H, W, 3], inputScale: 1/255, alpha: 0.3,
 *   convs:  [{ kernel: Float32Array HWIO [3,3,cin,cout], bias: Float32Array, bn: {gamma, beta, mean, variance, eps} }],
 *   denses: [{ kernel: Float32Array [in,out], bias: Float32Array }]   // last one = logits
 * }
 */
export function foldModel(spec) {
  const [H, W, C] = spec.inputShape;
  let h = H, w = W, cin = C;
  const convs = spec.convs.map((cv, li) => {
    const cout = cv.bias.length;
    const k = 3;
    const { gamma, beta, mean, variance, eps } = cv.bn;
    const kernel = new Float32Array(cout * k * k * cin); // OHWI
    const bias = new Float32Array(cout);
    for (let o = 0; o < cout; o++) {
      const s = gamma[o] / Math.sqrt(variance[o] + eps);
      const extra = li === 0 ? spec.inputScale : 1;
      bias[o] = (cv.bias[o] - mean[o]) * s + beta[o];
      for (let y = 0; y < k; y++)
        for (let x = 0; x < k; x++)
          for (let i = 0; i < cin; i++)
            kernel[((o * k + y) * k + x) * cin + i] = cv.kernel[((y * k + x) * cin + i) * cout + o] * s * extra;
    }
    const layer = { kernel, bias, cin, cout, k, h, w };
    h = Math.floor(h / 2); w = Math.floor(w / 2); cin = cout;
    return layer;
  });
  const flat = h * w * cin;
  let nin = flat;
  const denses = spec.denses.map((d) => {
    const nout = d.bias.length;
    const kernel = new Float32Array(nout * nin); // [out,in]
    for (let o = 0; o < nout; o++)
      for (let i = 0; i < nin; i++) kernel[o * nin + i] = d.kernel[i * nout + o];
    const layer = { kernel, bias: Float32Array.from(d.bias), nin, nout };
    nin = nout;
    return layer;
  });
  return { inputShape: spec.inputShape, alpha: spec.alpha, convs, denses, flatShape: [h, w, cin] };
}

// ---- float reference forward (folded weights, raw 0..255 input) ----
function conv(x, L) {
  const { h, w, cin, cout, k, kernel, bias } = L;
  const out = new Float32Array(h * w * cout);
  const p = (k - 1) >> 1;
  for (let y = 0; y < h; y++)
    for (let xx = 0; xx < w; xx++)
      for (let o = 0; o < cout; o++) {
        let acc = bias[o];
        for (let ky = 0; ky < k; ky++) {
          const iy = y + ky - p;
          if (iy < 0 || iy >= h) continue;
          for (let kx = 0; kx < k; kx++) {
            const ix = xx + kx - p;
            if (ix < 0 || ix >= w) continue;
            const xi = (iy * w + ix) * cin, wi = ((o * k + ky) * k + kx) * cin;
            for (let i = 0; i < cin; i++) acc += x[xi + i] * kernel[wi + i];
          }
        }
        out[(y * w + xx) * cout + o] = acc;
      }
  return out;
}
const leaky = (x, a) => x.map((v) => (v < 0 ? v * a : v));
function pool(x, h, w, c) {
  const oh = Math.floor(h / 2), ow = Math.floor(w / 2);
  const out = new Float32Array(oh * ow * c);
  for (let y = 0; y < oh; y++)
    for (let xx = 0; xx < ow; xx++)
      for (let ch = 0; ch < c; ch++) {
        let m = -Infinity;
        for (let dy = 0; dy < 2; dy++)
          for (let dx = 0; dx < 2; dx++) m = Math.max(m, x[((2 * y + dy) * w + 2 * xx + dx) * c + ch]);
        out[(y * ow + xx) * c + ch] = m;
      }
  return out;
}
function dense(x, L) {
  const out = new Float32Array(L.nout);
  for (let o = 0; o < L.nout; o++) {
    let acc = L.bias[o];
    const r = o * L.nin;
    for (let i = 0; i < L.nin; i++) acc += x[i] * L.kernel[r + i];
    out[o] = acc;
  }
  return out;
}

/** Float forward of the folded model. Returns {probs, acts} (acts: named intermediate arrays). */
export function forwardFloat(fm, image) {
  const acts = {};
  let x = Float32Array.from(image);
  fm.convs.forEach((L, i) => {
    x = conv(x, L); acts[`conv${i}`] = x;
    x = leaky(x, fm.alpha); acts[`act${i}`] = x;
    x = pool(x, L.h, L.w, L.cout);
  });
  fm.denses.forEach((L, i) => {
    x = dense(x, L); acts[`fc${i}`] = x;
    if (i < fm.denses.length - 1) { x = leaky(x, fm.alpha); acts[`fcact${i}`] = x; }
  });
  const m = Math.max(...x);
  const e = x.map((v) => Math.exp(v - m));
  const s = e.reduce((a, b) => a + b, 0);
  return { probs: e.map((v) => v / s), acts };
}

// ---- quantization helpers ----
function actParams(min, max) {
  min = Math.min(min, 0); max = Math.max(max, 0);
  let scale = (max - min) / 255;
  if (!(scale > 0)) scale = 1e-6;
  let zp = Math.round(-128 - min / scale);
  zp = Math.max(-128, Math.min(127, zp));
  return { scale: [scale], zeroPoint: [zp] };
}
const toBytes = (typed) => new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength);

function quantSymmetric(values, groups) {
  // groups: number of output channels (rows); returns {q:Int8Array, scales:[..]}
  const per = values.length / groups;
  const q = new Int8Array(values.length);
  const scales = [];
  for (let g = 0; g < groups; g++) {
    let m = 0;
    for (let i = 0; i < per; i++) m = Math.max(m, Math.abs(values[g * per + i]));
    const s = m > 0 ? m / 127 : 1e-8;
    scales.push(s);
    for (let i = 0; i < per; i++) q[g * per + i] = Math.max(-127, Math.min(127, Math.round(values[g * per + i] / s)));
  }
  return { q, scales };
}

/**
 * Calibrate activation ranges on sample images (raw 0..255, HWC Float32Array/Uint8Array)
 * and build the int8 .tflite. Returns {bytes: Uint8Array, folded}.
 */
export function exportTflite(spec, calibImages, { description = "meter-trainer-web" } = {}) {
  const fm = foldModel(spec);
  const ranges = {};
  for (const img of calibImages) {
    const { acts } = forwardFloat(fm, img);
    for (const [k, a] of Object.entries(acts)) {
      const r = (ranges[k] ||= [Infinity, -Infinity]);
      for (const v of a) { if (v < r[0]) r[0] = v; if (v > r[1]) r[1] = v; }
    }
  }
  const P = (k) => actParams(ranges[k][0], ranges[k][1]);

  const tensors = [], ops = [];
  const T = (t) => (tensors.push(t), tensors.length - 1);
  const [H, W, C] = fm.inputShape;

  const tIn = T({ name: "image", shape: [1, H, W, C], type: "f32" });
  let qIn = { scale: [1], zeroPoint: [-128] }; // raw pixels 0..255 -> int8 exactly
  let cur = T({ name: "image_q", shape: [1, H, W, C], type: "i8", quant: qIn });
  ops.push({ op: "QUANTIZE", inputs: [tIn], outputs: [cur] });

  fm.convs.forEach((L, i) => {
    const { q, scales } = quantSymmetric(L.kernel, L.cout);
    const sIn = qIn.scale[0];
    const bq = Int32Array.from(L.bias, (b, o) => Math.round(b / (sIn * scales[o])));
    const tW = T({ name: `conv${i}/w`, shape: [L.cout, L.k, L.k, L.cin], type: "i8", data: toBytes(q),
      quant: { scale: scales, zeroPoint: scales.map(() => 0), dim: 0 } });
    const tB = T({ name: `conv${i}/b`, shape: [L.cout], type: "i32", data: toBytes(bq),
      quant: { scale: scales.map((s) => s * sIn), zeroPoint: scales.map(() => 0), dim: 0 } });
    const qConv = P(`conv${i}`);
    const tC = T({ name: `conv${i}`, shape: [1, L.h, L.w, L.cout], type: "i8", quant: qConv });
    ops.push({ op: "CONV_2D", inputs: [cur, tW, tB], outputs: [tC], options: { padding: "SAME" } });
    const qAct = P(`act${i}`);
    const tA = T({ name: `act${i}`, shape: [1, L.h, L.w, L.cout], type: "i8", quant: qAct });
    ops.push({ op: "LEAKY_RELU", inputs: [tC], outputs: [tA], options: { alpha: fm.alpha } });
    const oh = Math.floor(L.h / 2), ow = Math.floor(L.w / 2);
    const tP = T({ name: `pool${i}`, shape: [1, oh, ow, L.cout], type: "i8", quant: qAct });
    ops.push({ op: "MAX_POOL_2D", inputs: [tA], outputs: [tP],
      options: { padding: "VALID", strideW: 2, strideH: 2, filterW: 2, filterH: 2 } });
    cur = tP; qIn = qAct;
  });

  const flat = fm.flatShape.reduce((a, b) => a * b, 1);
  const tShape = T({ name: "flatten/shape", shape: [2], type: "i32", data: toBytes(Int32Array.from([1, flat])) });
  const tFlat = T({ name: "flatten", shape: [1, flat], type: "i8", quant: qIn });
  ops.push({ op: "RESHAPE", inputs: [cur, tShape], outputs: [tFlat], options: { newShape: [1, flat] } });
  cur = tFlat;

  fm.denses.forEach((L, i) => {
    const last = i === fm.denses.length - 1;
    const { q, scales } = quantSymmetric(L.kernel, 1);
    const sIn = qIn.scale[0];
    const bq = Int32Array.from(L.bias, (b) => Math.round(b / (sIn * scales[0])));
    const tW = T({ name: `fc${i}/w`, shape: [L.nout, L.nin], type: "i8", data: toBytes(q),
      quant: { scale: scales, zeroPoint: [0] } });
    const tB = T({ name: `fc${i}/b`, shape: [L.nout], type: "i32", data: toBytes(bq),
      quant: { scale: [scales[0] * sIn], zeroPoint: [0] } });
    const qOut = P(`fc${i}`);
    const tO = T({ name: `fc${i}`, shape: [1, L.nout], type: "i8", quant: qOut });
    ops.push({ op: "FULLY_CONNECTED", inputs: [cur, tW, tB], outputs: [tO] });
    cur = tO; qIn = qOut;
    if (!last) {
      const qAct = P(`fcact${i}`);
      const tA = T({ name: `fcact${i}`, shape: [1, L.nout], type: "i8", quant: qAct });
      ops.push({ op: "LEAKY_RELU", inputs: [cur], outputs: [tA], options: { alpha: fm.alpha } });
      cur = tA; qIn = qAct;
    }
  });

  const nOut = fm.denses[fm.denses.length - 1].nout;
  const tSm = T({ name: "softmax", shape: [1, nOut], type: "i8", quant: { scale: [1 / 256], zeroPoint: [-128] } });
  ops.push({ op: "SOFTMAX", inputs: [cur], outputs: [tSm], options: { beta: 1 } });
  const tOut = T({ name: "output", shape: [1, nOut], type: "f32" });
  ops.push({ op: "DEQUANTIZE", inputs: [tSm], outputs: [tOut] });

  const bytes = buildTflite({ tensors, ops, inputs: [tIn], outputs: [tOut], description });
  return { bytes, folded: fm, ranges };
}
