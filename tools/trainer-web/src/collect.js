// Pull digit crops from the device's /log/digit/<YYYYMMDD>/<HH>/ folders into the browser.
//
// File names carry the device's own reading: "<pred>_<number>_<roi>_<YYYYMMDD-HHMMSS>.jpg".
// pred >= 100 marks a reading below CNNGoodThreshold (actual value pred - 100).
// The ESP32 serves ~3 files/s, so not every crop is fetched. The device's reading in the
// file name sorts each crop into a group (wheel + digit, or wheel + "between 7 and 8", or
// wheel + rejected); per group only `quota` crops are kept in total, spread evenly over
// time. A wheel at rest shows the same digit for days, so most of its crops are skipped.
import { list, getBytes } from "./device.js";
import { hasCrop, putCrops, kvGet, kvSet } from "./store.js";
import { decodeBrowser, IN_W, IN_H } from "./dataset.js";
import { resizeBilinear } from "./resize.js";
import { predLabel } from "./labels.js";

const NAME_RE = /^(-?\d+(?:\.\d+)?)_(.+)_([^_]+)_(\d{8}-\d{6})\.jpg$/i;

export function parseCropName(name) {
  const m = name.match(NAME_RE);
  if (!m) return null;
  let pred = +m[1];
  const rejected = pred >= 100;
  if (rejected) pred -= 100;
  return { pred, rejected, number: m[2], roi: m[3], ts: m[4] };
}

const pad = (n) => String(n).padStart(2, "0");
const dayKey = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;

function hourKeys() {
  const now = new Date(), prev = new Date(Date.now() - 3600000);
  return [`${dayKey(now)}/${pad(now.getHours())}`, `${dayKey(prev)}/${pad(prev.getHours())}`];
}

// Listings of finished hour folders and of past days never change, so they are kept in the
// browser: after a reload, a check only asks the device about folders it has not listed yet.
// "Finished" leaves a few hours of margin in case the device's clock runs in another time zone.
const STABLE_MS = 4 * 3600000;
const hourKey = (d) => `${dayKey(d)}/${pad(d.getHours())}`;
async function cachedList(path, keep) {
  const k = `ls:${path}`;
  if (keep) {
    const c = await kvGet(k);
    if (c) return { entries: c, cached: true };
  }
  const entries = await list(path);
  if (keep) await kvSet(k, entries);
  return { entries, cached: false };
}

export const groupOf = (roi, pred, rejected) => `${roi}|${rejected ? "rejected" : predLabel(pred)}`;

/** Evenly spaced pick of n items (sorted by ts). */
function spread(items, n) {
  if (n >= items.length) return items;
  if (n <= 0) return [];
  const out = [], step = items.length / n;
  for (let i = 0; i < n; i++) out.push(items[Math.floor(i * step + step / 2)]);
  return out;
}

/**
 * Step 1 of collecting: list the hour folders not collected yet (one small request each)
 * and decide what to download. Nothing is downloaded here.
 * have: Map group -> crops already stored. quota: crops wanted per group.
 * -> {hours, onDevice, toFetch, skippedEnough, have, groups: Map group -> {have, picked, available}}
 */
export async function scan({ days = 7, quota = 150, have = new Map(), shouldStop = () => false, onProgress = () => {} } = {}) {
  const doneHours = await kvGet("collectedHours", {});
  const oldest = dayKey(new Date(Date.now() - (days - 1) * 86400000));
  const live = hourKeys();
  const t0 = performance.now();
  const stableHour = hourKey(new Date(Date.now() - STABLE_MS));
  const stableDay = dayKey(new Date(Date.now() - 86400000 - STABLE_MS));
  const plan = { hours: [], onDevice: 0, toFetch: 0, have: 0, skippedEnough: 0, listed: 0, fromCache: 0, knownHours: 0, groups: new Map() };
  const dayDirs = (await list("log/digit")).filter((e) => e.dir && /^\d{8}$/.test(e.name) && e.name >= oldest);
  dayDirs.sort((a, b) => (a.name < b.name ? 1 : -1));
  const todo = [];
  for (const day of dayDirs) {
    if (shouldStop()) break;
    const hours = (await cachedList(`log/digit/${day.name}`, day.name < stableDay)).entries.filter((e) => e.dir && /^\d{2}$/.test(e.name));
    for (const h of hours.sort((a, b) => (a.name < b.name ? 1 : -1))) {
      const key = `${day.name}/${h.name}`;
      if (doneHours[key]) plan.knownHours++; else todo.push(key);
    }
  }
  const cand = new Map(); // group -> [{...file, id, hour}]
  for (const key of todo) {
    if (shouldStop()) break;
    onProgress({ listed: plan.listed, total: todo.length, folder: key });
    const ls = await cachedList(`log/digit/${key}`, key < stableHour);
    if (ls.cached) plan.fromCache++;
    const files = ls.entries.filter((e) => !e.dir);
    plan.onDevice += files.length;
    for (const f of files) {
      const meta = parseCropName(f.name);
      if (!meta) continue;
      const id = f.href.replace(/^\/fileserver\//, "");
      if (await hasCrop(id)) { plan.have++; continue; }
      const g = groupOf(meta.roi, meta.pred, meta.rejected);
      if (!cand.has(g)) cand.set(g, []);
      cand.get(g).push({ ...f, ...meta, id, hour: key });
    }
    plan.hours.push({ key, items: [], live: live.includes(key) });
    plan.listed++;
  }
  const byHour = new Map(plan.hours.map((h) => [h.key, h]));
  for (const [g, items] of cand) {
    items.sort((a, b) => (a.ts < b.ts ? -1 : 1));
    const already = have.get(g) || 0;
    const pick = spread(items, Math.max(0, quota - already));
    pick.forEach((it) => byHour.get(it.hour).items.push(it));
    plan.toFetch += pick.length;
    plan.skippedEnough += items.length - pick.length;
    plan.groups.set(g, { have: already, picked: pick.length, available: items.length });
  }
  plan.complete = plan.listed === todo.length;
  plan.listSeconds = (performance.now() - t0) / 1000;
  return plan;
}

/**
 * Step 2: download what scan() chose. onProgress({fetched, failed, total, rate, folder}),
 * rate = images per second measured so far.
 */
export async function download(plan, { shouldStop = () => false, onProgress = () => {} } = {}) {
  const doneHours = await kvGet("collectedHours", {});
  const stats = { fetched: 0, failed: 0, total: plan.toFetch, folders: 0, rate: 0 };
  const t0 = performance.now();
  for (const h of plan.hours) {
    if (shouldStop()) break;
    let batch = [], left = 0;
    for (const f of h.items) {
      if (shouldStop()) { left++; continue; }
      try {
        const bytes = await getBytes(f.href, 20000);
        const im = await decodeBrowser(bytes);
        const pix = resizeBilinear(im.data, im.width, im.height, IN_W, IN_H, 4);
        batch.push({ crop: { id: f.id, roi: f.roi, number: f.number, ts: f.ts, pred: f.pred, rejected: f.rejected, w: im.width, h: im.height, pix }, jpeg: bytes });
        stats.fetched++;
      } catch {
        stats.failed++;
      }
      if (batch.length >= 25) { await putCrops(batch); batch = []; }
      stats.rate = (stats.fetched + stats.failed) / ((performance.now() - t0) / 1000);
      onProgress({ ...stats, folder: h.key });
    }
    if (batch.length) await putCrops(batch);
    if (!left && !shouldStop() && !h.live) { doneHours[h.key] = h.items.length || 1; await kvSet("collectedHours", doneHours); }
    stats.folders++;
  }
  return stats;
}
