// Project data in the browser (IndexedDB, per device address):
//   crops   {id, roi, ts, pred, rejected, pix: Uint8Array(32*20*3)}   small, loaded for training
//   jpeg    {id, bytes: Uint8Array}                                   original crop, for review/LLM
//   labels  {id, human?, llm?, llmModel?, at}                          labels from people and LLMs
//   kv      settings, collection progress, trained models, config backups
const DB = "meter-trainer", VERSION = 1;
let dbp = null;

function open() {
  dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open(DB, VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      db.createObjectStore("crops", { keyPath: "id" }).createIndex("roi", "roi");
      db.createObjectStore("jpeg", { keyPath: "id" });
      db.createObjectStore("labels", { keyPath: "id" });
      db.createObjectStore("kv");
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}

const done = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
async function tx(stores, mode, fn) {
  const db = await open();
  const t = db.transaction(stores, mode);
  const out = fn(...[].concat(stores).map((s) => t.objectStore(s)));
  await new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });
  return out;
}

export async function putCrops(items) { // [{crop, jpeg}]
  await tx(["crops", "jpeg"], "readwrite", (c, j) => {
    for (const it of items) { c.put(it.crop); j.put({ id: it.crop.id, bytes: it.jpeg }); }
  });
}
export async function hasCrop(id) { return !!(await tx("crops", "readonly", (c) => done(c.getKey(id)))); }
export async function allCrops() { return tx("crops", "readonly", (c) => done(c.getAll())); }
export async function countCrops() { return tx("crops", "readonly", (c) => done(c.count())); }
export async function getJpeg(id) { return (await tx("jpeg", "readonly", (j) => done(j.get(id))))?.bytes; }

export async function allLabels() {
  const rows = await tx("labels", "readonly", (l) => done(l.getAll()));
  return new Map(rows.map((r) => [r.id, r]));
}
/** Merge fields into a label record (null removes a field). */
export async function setLabel(id, fields) {
  await tx("labels", "readwrite", async (l) => {
    const cur = (await done(l.get(id))) || { id };
    for (const [k, v] of Object.entries(fields)) { if (v === null) delete cur[k]; else cur[k] = v; }
    cur.at = Date.now();
    l.put(cur);
  });
}

/** Bulk write whole label records [{id, human?, llm?, ...}] */
export async function putLabels(records) {
  await tx("labels", "readwrite", (l) => { for (const r of records) l.put({ ...r, at: Date.now() }); });
}

export const kvGet =(key, dflt = null) => tx("kv", "readonly", (s) => done(s.get(key))).then((v) => v ?? dflt);
export const kvSet = (key, value) => tx("kv", "readwrite", (s) => { s.put(value, key); });

export async function clearAll() {
  await tx(["crops", "jpeg", "labels", "kv"], "readwrite", (...s) => s.forEach((x) => x.clear()));
}

/** Ask the browser not to evict the project when disk space runs low. */
export async function persist() {
  try { return await navigator.storage?.persist?.(); } catch { return false; }
}
export async function usage() {
  try { return await navigator.storage.estimate(); } catch { return null; }
}
