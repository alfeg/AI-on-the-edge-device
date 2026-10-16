// Is the device set up to produce training data, and is there enough of it?
import { getKey, setKey, digitRois } from "./ini.js";
import { LABELS } from "./labels.js";
import { t } from "../i18n/index.js";

export const RECOMMENDED_RETENTION = 14; // days of digit crops kept on the SD card
export const MIN_PER_DIGIT = 30;         // usable crops per digit 0-9 (all wheels together)
export const MIN_COMPARE = 100;         // test images the device read itself, needed to compare models
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

  if (!rois.length) out.push({ level: "block", title: t("No digit wheels are configured"), detail: t("Set up the digit ROIs in the device's configuration first.") });
  else out.push({ level: "ok", title: t("{n} digit wheels configured", { n: rois.length }), detail: rois.map((r) => r.name).join(", ") });

  const retention = (ret?.enabled && ret.value !== "") ? +ret.value : 3;
  const setLogging = (text) => setKey(setKey(text, "Digits", "ROIImagesLocation", "/log/digit"), "Digits", "ROIImagesRetention", String(RECOMMENDED_RETENTION));
  if (!loc?.enabled || !loc.value) {
    out.push({ level: "block", title: t("The device is not saving digit images"),
      detail: t("Without saved crops there is nothing to train on. Turning it on sets ROIImagesLocation = /log/digit and keeps {days} days (about {n} small images a day). The device restarts once.",
        { days: RECOMMENDED_RETENTION, n: perDay * rois.length }),
      fix: { label: t("Turn on image saving"), apply: setLogging } });
  } else if (retention > 0 && retention < 7) {
    out.push({ level: "warn", title: t("Digit images are deleted after {n} days", { n: retention }),
      detail: t("Collect at least every {n} days, or keep them longer. {rec} days lets you train on two weeks of data.", { n: retention, rec: RECOMMENDED_RETENTION }),
      fix: { label: t("Keep {n} days", { n: RECOMMENDED_RETENTION }), apply: (text) => setKey(text, "Digits", "ROIImagesRetention", String(RECOMMENDED_RETENTION)) } });
  } else if (retention === 0) {
    out.push({ level: "info", title: t("Digit images are kept forever"),
      detail: t("The SD card fills up and wears out over time (the device does no wear levelling). Consider a limit such as 30 days.") });
  } else {
    out.push({ level: "ok", title: t("Digit images are saved and kept {n} days", { n: retention }), detail: t("{path}, about {n} images a day.", { path: loc.value, n: perDay * rois.length }) });
  }

  if (!raw?.enabled || !raw.value) {
    out.push({ level: "info", title: t("Full photos are not saved"),
      detail: t("Only needed to train a wheel the device does not read yet. Enable RawImagesLocation in [TakeImage] for that.") });
  }
  out.push({ level: "info", title: t("A reading every {n} min", { n: interval }), detail: t("{n} rounds a day.", { n: perDay }) });
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
  for (const d of LABELS.slice(0, 10)) if (perDigit[d] < MIN_PER_DIGIT) missing.push(t("digit {d}: {n}/{min}", { d, n: perDigit[d], min: MIN_PER_DIGIT }));
  for (const g of rois.filter((r) => r.rolling)) {
    for (const t of LABELS.slice(10)) if (g.labels[t] < MIN_PER_TRANSITION) missing.push(`${g.roi} ${t}: ${g.labels[t]}/${MIN_PER_TRANSITION}`);
  }
  const days = Math.max(0, ...rois.map((r) => r.days));
  let verdict = "ready";
  if (!crops.length) verdict = "blocked";
  else if (missing.length || days < 2) verdict = "not-enough";
  return { rois, perDigit, verdict, missing, days };
}
