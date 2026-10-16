// The project in this browser: collected crops, their label records and the effective label
// of each crop. These collections are large (every crop carries its pixels), so they stay
// plain JS outside Vue's reactivity: change them through this module, which bumps `rev`.
import { ref, shallowRef, watch } from "vue";
import * as store from "@/services/db.js";
import { effective, steadyLabels } from "@/lib/labels.js";
import { coverage } from "@/lib/readiness.js";
import { t } from "@/i18n/index.js";
import { app, setPill, say } from "@/stores/app.js";
import { num } from "@/utils/format.js";

export const data = {
  crops: [],            // [{ id, roi, ts, pred, rejected, w, h, pix }]
  labels: new Map(),    // id -> { id, human?, llm?, llmModel? }
  steady: new Map(),    // id -> label of a wheel that stayed the same for several readings
  eff: new Map(),       // id -> { label, status, sources, score }
};
/** Bumped whenever labels change (tiles and counts re-read data then). */
export const rev = ref(0);
/** Bumped when the whole project was reloaded (the review starts over then). */
export const loads = ref(0);
/** Usable images per wheel and label, and the readiness verdict. */
export const cov = shallowRef(coverage([], new Map()));

// the Labels step's status word follows the coverage verdict
watch(cov, (c) => {
  if (!c.rois.length) setPill("labels", "–");
  else if (c.verdict === "ready") setPill("labels", "ready to train", "ok");
  else if (c.verdict === "not-enough") setPill("labels", "not enough yet", "warn");
});

const DEBUG = location.search.includes("debug");
const tlog = (label, t0) => { if (DEBUG) console.log(`[timing] ${label}: ${(performance.now() - t0).toFixed(0)} ms`); };

export async function refreshProject() {
  const t0 = performance.now();
  data.crops = await store.allCrops();
  data.labels = await store.allLabels();
  data.steady = steadyLabels(data.crops);
  data.eff = new Map(data.crops.map((c) => [c.id, effective(c, data.labels.get(c.id), data.steady)]));
  cov.value = coverage(data.crops, data.eff);
  tlog(`refreshProject ${data.crops.length}`, t0);
  rev.value++; loads.value++;
  const n = data.crops.length;
  setPill("collect", n ? "{n} images" : "empty", n ? "ok" : "", { n: num(n) });
  const est = await store.usage();
  if (est && !app.busy) say("collect", t("{n} images stored in this browser", { n: num(n) }) + (est.usage ? t(" ({mb} MB used)", { mb: (est.usage / 1e6).toFixed(0) }) : ""));
}

/** Recount after labels changed (debounced: keyboard labelling can be fast). */
let covTimer = 0;
function scheduleCoverage() {
  clearTimeout(covTimer);
  covTimer = setTimeout(() => { cov.value = coverage(data.crops, data.eff); }, 250);
}

/** Keeps label records (already saved) and recomputes the crops' effective labels. */
export function applyLabels(recs) {
  const byId = new Map(data.crops.map((c) => [c.id, c]));
  for (const r of recs) {
    data.labels.set(r.id, r);
    const c = byId.get(r.id);
    if (c) data.eff.set(r.id, effective(c, r, data.steady));
  }
  rev.value++;
  scheduleCoverage();
}

/** Changes some fields of one crop's label record (null removes a field) and saves it. */
export async function setLabelFields(crop, fields) {
  await store.setLabel(crop.id, fields);
  const rec = { ...(data.labels.get(crop.id) || { id: crop.id }) };
  for (const [k, v] of Object.entries(fields)) { if (v === null) delete rec[k]; else rec[k] = v; }
  data.labels.set(crop.id, rec);
  data.eff.set(crop.id, effective(crop, rec, data.steady));
  rev.value++;
  scheduleCoverage();
}

export const effOf = (id) => data.eff.get(id);
export const usableSt = (st) => st === "human" || st === "confirmed";
export const reviewSt = (st) => st === "unconfirmed" || st === "conflict";

/** Crops behind one coverage cell: label "*usable", "*review" or a label like "7/8". */
export function cellCrops(roi, l) {
  return data.crops.filter((c) => {
    if (c.roi !== roi) return false;
    const e = data.eff.get(c.id);
    if (l === "*usable") return usableSt(e.status);
    if (l === "*review") return reviewSt(e.status);
    return usableSt(e.status) && e.label === l;
  });
}

/** A crop's JPEG as an object URL (revoke it when done), or null. */
export async function cropUrl(id) {
  const b = await store.getJpeg(id);
  return b ? URL.createObjectURL(new Blob([b], { type: "image/jpeg" })) : null;
}
