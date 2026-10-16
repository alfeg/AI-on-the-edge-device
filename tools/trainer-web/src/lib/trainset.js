// Build training arrays from the stored crops and their effective labels.
//  - test split, per wheel: the newest ~20% of that wheel's days (or of its images, with
//    fewer than 5 days), so the result says how the model does on days it has not seen.
//    Per wheel, so a wheel added recently (all its images from the last days) still
//    keeps most of its images for training.
//  - all: no test split; the final model trains on every usable image
//  - only "you" and "confirmed" labels, unless includeUnconfirmed
//  - per wheel and label at most `cap` training crops, spread evenly over time (a wheel at
//    rest would otherwise flood the set with one picture)
import { PIX } from "./dataset.js";
import { target } from "./labels.js";

/** Per wheel: a predicate "is this row a test row", from the newest days or images of the wheel. */
function testSplit(rows, testFrac) {
  const byRoi = new Map();
  for (const r of rows) { if (!byRoi.has(r.roi)) byRoi.set(r.roi, []); byRoi.get(r.roi).push(r); }
  const cut = new Map(); // roi -> {days?: Set, ts?: string}
  for (const [roi, rs] of byRoi) {
    const days = [...new Set(rs.map((r) => r.ts.slice(0, 8)))].sort();
    if (days.length >= 5) cut.set(roi, { days: new Set(days.slice(days.length - Math.max(1, Math.round(days.length * testFrac)))) });
    else cut.set(roi, { ts: rs[Math.floor(rs.length * (1 - testFrac))]?.ts ?? "99999999" }); // rs is sorted by ts
  }
  return (r) => { const c = cut.get(r.roi); return c.days ? c.days.has(r.ts.slice(0, 8)) : r.ts >= c.ts; };
}

export function buildTrainSet(crops, eff, { includeUnconfirmed = false, cap = 300, testFrac = 0.2, all = false } = {}) {
  const ok = (s) => s === "human" || s === "confirmed" || (includeUnconfirmed && s === "unconfirmed");
  const rows = crops.filter((c) => { const e = eff.get(c.id); return e && e.label && ok(e.status); })
    .sort((a, b) => (a.ts < b.ts ? -1 : 1));
  const days = [...new Set(rows.map((r) => r.ts.slice(0, 8)))].sort();
  const isTest = all ? () => false : testSplit(rows, testFrac);
  const test = [], groups = new Map();
  for (const r of rows) {
    const e = eff.get(r.id);
    if (isTest(r)) { if (e.status !== "unconfirmed") test.push(r); continue; }
    const k = `${r.roi}|${e.label}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const train = [];
  for (const g of groups.values()) {
    if (g.length <= cap) { train.push(...g); continue; }
    const step = (g.length - 1) / (cap - 1);
    for (let i = 0; i < cap; i++) train.push(g[Math.round(i * step)]);
  }
  const rowsOut = [...train, ...test];
  const X = new Uint8Array(rowsOut.length * PIX), Y = new Float32Array(rowsOut.length * 10);
  const meta = rowsOut.map((r, i) => {
    X.set(r.pix, i * PIX);
    const e = eff.get(r.id);
    Y.set(target(e.label), i * 10);
    return { id: r.id, roi: r.roi, ts: r.ts, label: e.label, status: e.status, pred: r.pred, rejected: r.rejected };
  });
  const trainIdx = train.map((_, i) => i);
  for (let i = trainIdx.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [trainIdx[i], trainIdx[j]] = [trainIdx[j], trainIdx[i]]; }
  const nVal = Math.max(1, Math.round(trainIdx.length * 0.08));
  return {
    X, Y, meta,
    valIdx: trainIdx.slice(0, nVal), trainIdx: trainIdx.slice(nVal),
    testIdx: test.map((_, k) => train.length + k),
    days: days.length,
  };
}

/** Per wheel: model accuracy vs the device's own reading on the test crops. */
export function compareOnTest(set, probs) {
  const g = new Map();
  set.testIdx.forEach((r, k) => {
    const m = set.meta[r];
    let am = 0;
    for (let c = 1; c < 10; c++) if (probs[k * 10 + c] > probs[k * 10 + am]) am = c;
    const isT = m.label.includes("/");
    const e = g.get(m.roi) || { roi: m.roi, n: 0, model: 0, dev: 0, devN: 0, modelOnDev: 0, t: 0, tModel: 0 };
    e.n++; e.model += set.Y[r * 10 + am] >= 0.5;
    if (isT) { e.t++; e.tModel += set.Y[r * 10 + am] >= 0.5; }
    if (m.pred != null) { // same images for both: only those the device read itself
      e.devN++;
      e.dev += !m.rejected && set.Y[r * 10 + (Math.round(m.pred) % 10)] >= 0.5;
      e.modelOnDev += set.Y[r * 10 + am] >= 0.5;
    }
    g.set(m.roi, e);
  });
  return [...g.values()].sort((a, b) => a.roi.localeCompare(b.roi, undefined, { numeric: true }));
}
