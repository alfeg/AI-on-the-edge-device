// Pull digit crops from the device's /log/digit/<YYYYMMDD>/<HH>/ folders into the browser.
//
// File names carry the device's own reading: "<pred>_<number>_<roi>_<YYYYMMDD-HHMMSS>.jpg".
// pred >= 100 marks a reading below CNNGoodThreshold (actual value pred - 100).
// The ESP32 serves ~3 files/s, so not every crop is fetched: per wheel and hour we keep
// every crop whose reading changed, every rejected or between-digits reading, and one in
// `keepEvery` of the unchanged ones (a stopped wheel looks the same for hours).
import { list, getBytes } from "./device.js";
import { hasCrop, putCrops, kvGet, kvSet } from "./store.js";
import { decodeBrowser, IN_W, IN_H } from "./dataset.js";
import { resizeBilinear } from "./resize.js";

const NAME_RE = /^(-?\d+(?:\.\d+)?)_(.+)_([^_]+)_(\d{8}-\d{6})\.jpg$/i;

export function parseCropName(name) {
  const m = name.match(NAME_RE);
  if (!m) return null;
  let pred = +m[1];
  const rejected = pred >= 100;
  if (rejected) pred -= 100;
  return { pred, rejected, number: m[2], roi: m[3], ts: m[4] };
}

const near = (v) => { const f = v - Math.floor(v); return f > 0.25 && f < 0.75; };

/** Choose which files of one hour folder to fetch. files: [{name, href}] */
export function selectFiles(files, keepEvery = 6) {
  const byRoi = new Map();
  for (const f of files) {
    const p = parseCropName(f.name);
    if (!p) continue;
    if (!byRoi.has(p.roi)) byRoi.set(p.roi, []);
    byRoi.get(p.roi).push({ ...f, ...p });
  }
  const out = [];
  for (const items of byRoi.values()) {
    items.sort((a, b) => (a.ts < b.ts ? -1 : 1));
    let prev = null, quiet = 0;
    for (const it of items) {
      const digit = Math.round(it.pred) % 10;
      const changed = prev === null || digit !== prev;
      if (changed || it.rejected || near(it.pred) || ++quiet >= keepEvery) { out.push(it); quiet = 0; }
      prev = digit;
    }
  }
  return out;
}

const pad = (n) => String(n).padStart(2, "0");
const dayKey = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;

/**
 * Collect up to `days` days back. Hour folders older than 2 h are remembered as complete.
 * opts: {days, keepEvery, shouldStop, onProgress({phase, folder, fetched, skipped, total})}
 */
export async function collect({ days = 7, keepEvery = 6, shouldStop = () => false, onProgress = () => {} } = {}) {
  const doneHours = await kvGet("collectedHours", {});
  const oldest = dayKey(new Date(Date.now() - (days - 1) * 86400000));
  const now = new Date();
  const liveHour = `${dayKey(now)}/${pad(now.getHours())}`;
  const prevHour = (() => { const d = new Date(Date.now() - 3600000); return `${dayKey(d)}/${pad(d.getHours())}`; })();
  const stats = { fetched: 0, skipped: 0, failed: 0, folders: 0 };

  const dayDirs = (await list("log/digit")).filter((e) => e.dir && /^\d{8}$/.test(e.name) && e.name >= oldest);
  dayDirs.sort((a, b) => (a.name < b.name ? 1 : -1)); // newest first: most useful if stopped early
  for (const day of dayDirs) {
    if (shouldStop()) break;
    const hours = (await list(`log/digit/${day.name}`)).filter((e) => e.dir && /^\d{2}$/.test(e.name));
    hours.sort((a, b) => (a.name < b.name ? 1 : -1));
    for (const h of hours) {
      if (shouldStop()) break;
      const key = `${day.name}/${h.name}`;
      if (doneHours[key]) continue;
      onProgress({ phase: "list", folder: key, ...stats });
      const files = (await list(`log/digit/${key}`)).filter((e) => !e.dir);
      const pick = selectFiles(files, keepEvery);
      let batch = [];
      for (const f of pick) {
        if (shouldStop()) break;
        const id = f.href.replace(/^\/fileserver\//, "");
        if (await hasCrop(id)) { stats.skipped++; continue; }
        try {
          const bytes = await getBytes(f.href, 20000);
          const im = await decodeBrowser(bytes);
          const pix = resizeBilinear(im.data, im.width, im.height, IN_W, IN_H, 4);
          batch.push({ crop: { id, roi: f.roi, number: f.number, ts: f.ts, pred: f.pred, rejected: f.rejected, w: im.width, h: im.height, pix }, jpeg: bytes });
          stats.fetched++;
        } catch {
          stats.failed++;
        }
        if (batch.length >= 25) { await putCrops(batch); batch = []; }
        onProgress({ phase: "fetch", folder: key, ...stats });
      }
      if (batch.length) await putCrops(batch);
      if (!shouldStop() && key !== liveHour && key !== prevHour) { doneHours[key] = pick.length; await kvSet("collectedHours", doneHours); }
      stats.folders++;
    }
  }
  return stats;
}
