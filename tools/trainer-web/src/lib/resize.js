// Port of PIL Image.resize(..., BILINEAR) for RGB(A) uint8 pixels: separable triangle
// filter whose support widens on downscale (antialias), horizontal pass then vertical,
// each rounded to uint8. Matches the Python pipeline (prepare.py / tflite_eval.py), which
// produced the training data of the deployed models.

function coeffs(inSize, outSize) {
  const scale = inSize / outSize;
  const filterscale = Math.max(scale, 1);
  const support = filterscale; // bilinear support = 1
  const out = [];
  for (let o = 0; o < outSize; o++) {
    const center = (o + 0.5) * scale;
    const xmin = Math.max(Math.trunc(center - support + 0.5), 0);
    const n = Math.min(Math.trunc(center + support + 0.5), inSize) - xmin;
    const w = new Float64Array(n);
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const t = Math.abs((i + xmin - center + 0.5) / filterscale);
      w[i] = t < 1 ? 1 - t : 0;
      sum += w[i];
    }
    if (sum) for (let i = 0; i < n; i++) w[i] /= sum;
    out.push({ xmin, w });
  }
  return out;
}

const clip8 = (v) => (v <= 0 ? 0 : v >= 255 ? 255 : Math.floor(v + 0.5));

/**
 * src: Uint8ClampedArray/Uint8Array RGBA (stride 4) or RGB (stride 3), srcW x srcH
 * returns Uint8Array RGB dstW x dstH
 */
export function resizeBilinear(src, srcW, srcH, dstW, dstH, stride = 4) {
  const ch = coeffs(srcW, dstW);
  const tmp = new Uint8Array(dstW * srcH * 3);
  for (let y = 0; y < srcH; y++)
    for (let x = 0; x < dstW; x++) {
      const { xmin, w } = ch[x];
      let r = 0, g = 0, b = 0;
      for (let i = 0; i < w.length; i++) {
        const p = (y * srcW + xmin + i) * stride;
        r += src[p] * w[i]; g += src[p + 1] * w[i]; b += src[p + 2] * w[i];
      }
      const q = (y * dstW + x) * 3;
      tmp[q] = clip8(r); tmp[q + 1] = clip8(g); tmp[q + 2] = clip8(b);
    }
  const cv = coeffs(srcH, dstH);
  const out = new Uint8Array(dstW * dstH * 3);
  for (let y = 0; y < dstH; y++) {
    const { xmin, w } = cv[y];
    for (let x = 0; x < dstW; x++) {
      let r = 0, g = 0, b = 0;
      for (let i = 0; i < w.length; i++) {
        const p = ((xmin + i) * dstW + x) * 3;
        r += tmp[p] * w[i]; g += tmp[p + 1] * w[i]; b += tmp[p + 2] * w[i];
      }
      const q = (y * dstW + x) * 3;
      out[q] = clip8(r); out[q + 1] = clip8(g); out[q + 2] = clip8(b);
    }
  }
  return out;
}
