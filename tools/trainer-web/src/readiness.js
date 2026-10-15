// Is the device set up to produce training data, and is there enough of it?
import { getKey, setKey, digitRois } from "./ini.js";
import { LABELS } from "./labels.js";

export const RECOMMENDED_RETENTION = 14; // days of digit crops kept on the SD card
export const MIN_PER_DIGIT = 30;         // usable crops per digit 0-9 (all wheels together)
export const MIN_PER_TRANSITION = 15;    // per between-digits position, on rolling wheels

/** -> [{level: block|warn|info|ok, title, detail, fix?: {label, apply(text) -> text}}] */
export function configChecks(text) {
  const out = [];
  const loc = getKey(text, "Digits", "ROIImagesLocation");
  const ret = getKey(text, "Digits", "ROIImagesRetention");
  const raw = getKey(text, "TakeImage", "RawImagesLocation");
  const interval = parseFloat(getKey(text, "AutoTimer", "Interval")?.value || "5") || 5;
  const rois = digitRois(text);
  const perDay = Math.round((24 * 60) / interval);

  if (!rois.length) out.push({ level: "block", title: "No digit wheels are configured", detail: "Set up the digit ROIs in the device's configuration first." });
  else out.push({ level: "ok", title: `${rois.length} digit wheels configured`, detail: rois.map((r) => r.name).join(", ") });

  const retention = (ret?.enabled && ret.value !== "") ? +ret.value : 3;
  const setLogging = (t) => setKey(setKey(t, "Digits", "ROIImagesLocation", "/log/digit"), "Digits", "ROIImagesRetention", String(RECOMMENDED_RETENTION));
  if (!loc?.enabled || !loc.value) {
    out.push({ level: "block", title: "The device is not saving digit images",
      detail: "Without saved crops there is nothing to train on. Turning it on sets ROIImagesLocation = /log/digit and keeps " +
        `${RECOMMENDED_RETENTION} days (about ${perDay * rois.length} small images a day). The device restarts once.`,
      fix: { label: "Turn on image saving", apply: setLogging } });
  } else if (retention > 0 && retention < 7) {
    out.push({ level: "warn", title: `Digit images are deleted after ${retention} days`,
      detail: `Collect at least every ${retention} days, or keep them longer. ${RECOMMENDED_RETENTION} days lets you train on two weeks of data.`,
      fix: { label: `Keep ${RECOMMENDED_RETENTION} days`, apply: (t) => setKey(t, "Digits", "ROIImagesRetention", String(RECOMMENDED_RETENTION)) } });
  } else if (retention === 0) {
    out.push({ level: "info", title: "Digit images are kept forever",
      detail: "The SD card fills up and wears out over time (the device does no wear levelling). Consider a limit such as 30 days." });
  } else {
    out.push({ level: "ok", title: `Digit images are saved and kept ${retention} days`, detail: `${loc.value}, about ${perDay * rois.length} images a day.` });
  }

  if (!raw?.enabled || !raw.value) {
    out.push({ level: "info", title: "Full photos are not saved",
      detail: "Only needed to train a wheel the device does not read yet. Enable RawImagesLocation in [TakeImage] for that." });
  }
  out.push({ level: "info", title: `A reading every ${interval} min`, detail: `${perDay} rounds a day.` });
  return out;
}

/**
 * crops: [{id, roi, ts}], eff: Map id -> {label, status}
 * -> {rois:[{roi, crops, days, usable, review, labels:{l:n}, rolling}], perDigit, verdict, missing}
 */
export function coverage(crops, eff) {
  const byRoi = new Map();
  for (const c of crops) {
    if (!byRoi.has(c.roi)) byRoi.set(c.roi, { roi: c.roi, crops: 0, days: new Set(), usable: 0, review: 0, near: 0, labels: Object.fromEntries(LABELS.map((l) => [l, 0])) });
    const g = byRoi.get(c.roi);
    g.crops++; g.days.add(c.ts.slice(0, 8));
    if (c.pred != null) { const f = c.pred - Math.floor(c.pred); if (f > 0.3 && f < 0.7) g.near++; }
    const e = eff.get(c.id);
    if (e?.status === "human" || e?.status === "confirmed") { g.usable++; if (e.label in g.labels) g.labels[e.label]++; }
    else if (e?.status === "unconfirmed" || e?.status === "conflict") g.review++;
  }
  const rois = [...byRoi.values()].map((g) => ({ ...g, days: g.days.size, rolling: g.near / Math.max(1, g.crops) > 0.05 }))
    .sort((a, b) => a.roi.localeCompare(b.roi, undefined, { numeric: true }));
  const perDigit = Object.fromEntries(LABELS.slice(0, 10).map((d) => [d, 0]));
  rois.forEach((g) => LABELS.slice(0, 10).forEach((d) => { perDigit[d] += g.labels[d]; }));
  const missing = [];
  for (const d of LABELS.slice(0, 10)) if (perDigit[d] < MIN_PER_DIGIT) missing.push(`digit ${d}: ${perDigit[d]}/${MIN_PER_DIGIT}`);
  for (const g of rois.filter((r) => r.rolling)) {
    for (const t of LABELS.slice(10)) if (g.labels[t] < MIN_PER_TRANSITION) missing.push(`${g.roi} ${t}: ${g.labels[t]}/${MIN_PER_TRANSITION}`);
  }
  const days = Math.max(0, ...rois.map((r) => r.days));
  let verdict = "ready";
  if (!crops.length) verdict = "blocked";
  else if (missing.length || days < 2) verdict = "not-enough";
  return { rois, perDigit, verdict, missing, days };
}
