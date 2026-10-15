// The AI-on-the-edge device's own HTTP API, called from a page the device serves
// (same origin, so no CORS). Requests are sequential: the ESP32 serves one at a time and
// also has to keep its reading rounds going.
import { md5 } from "./md5.js";
import { t } from "./i18n.js";

const base = "";
let chain = Promise.resolve();
/** Run requests one after another. */
function queued(fn) {
  const p = chain.then(fn, fn);
  chain = p.catch(() => {});
  return p;
}

async function req(path, opts = {}, timeoutMs = 30000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(base + path, { ...opts, signal: ctl.signal, cache: "no-store" });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      const err = new Error(`${opts.method || "GET"} ${path}: HTTP ${r.status} ${body.slice(0, 120)}`);
      err.status = r.status;
      throw err;
    }
    return r;
  } finally {
    clearTimeout(t);
  }
}

export const getText = (path, timeout) => queued(async () => (await req(path, {}, timeout)).text());
export const getBytes = (path, timeout) => queued(async () => new Uint8Array(await (await req(path, {}, timeout)).arrayBuffer()));

/** Is this page served by an AI-on-the-edge device? */
export async function detect() {
  try {
    const s = await getText("/statusflow", 8000);
    return { ok: true, status: s.trim() };
  } catch {
    return { ok: false };
  }
}

/** Directory listing of /fileserver/<path>/ -> [{name, href, dir, size}] */
export async function list(path) {
  const html = await getText(`/fileserver/${path.replace(/^\/|\/$/g, "")}/`);
  const out = [];
  const re = /<tr><td><a href="([^"]+)">([^<]*)<\/a><\/td><td>(directory|file)<\/td><td>([^<]*)<\/td>/g;
  let m;
  while ((m = re.exec(html))) out.push({ href: m[1], name: m[2], dir: m[3] === "directory", size: m[4] });
  return out;
}

/** The device's name: its hostname, else the MQTT topic from config.ini, else "". */
export async function meterName(configText) {
  try {
    const h = (await getText("/info?type=Hostname", 8000)).trim();
    if (h && h !== "undefined") return h;
  } catch { /* older firmware: fall through */ }
  const m = /^\[MQTT\][^[]*?^\s*MainTopic\s*=\s*(\S+)/m.exec(configText || "");
  return m ? m[1] : "";
}

export const readConfig = () => getText("/fileserver/config/config.ini");
export const statusFlow = async () => (await getText("/statusflow", 10000)).trim();
export const readValue = async () => JSON.parse(await getText("/json", 10000));

async function del(path) {
  try { await queued(() => req(`/delete${path}`, { method: "POST" })); } catch (e) { if (e.status !== 404) throw e; }
}

/** Upload bytes to an SD path ("/config/x.tflite"), replacing an existing file; verified by MD5. */
export async function upload(path, bytes) {
  await del(path);
  const r = await queued(() => req(`/upload${path}?md5`, { method: "POST", body: bytes }, 120000));
  const got = (await r.json()).md5;
  const want = md5(bytes);
  if (got !== want) throw new Error(t("upload of {path} corrupted (device MD5 {got}, expected {want})", { path, got, want }));
  return want;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait until a reading round has just finished, so a config change and reboot don't
 * interrupt one (doing that once left both meters crash-looping until power-cycled).
 */
export async function waitRoundEnd(onStatus = () => {}, maxMs = 6 * 60000) {
  const first = await statusFlow();
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const s = await statusFlow();
    onStatus(s);
    if (s.startsWith("Flow finished") && s !== first) return s;
    await sleep(3000);
  }
  throw new Error(t("no reading round finished within 6 minutes"));
}

/**
 * Replace config.ini and reboot: backup first (/config/config_<ts>.ini.bak), push right
 * after a round ends, verify by MD5, then reboot. Returns the backup path.
 */
export async function writeConfigAndReboot(newText, onStatus = () => {}) {
  const old = await readConfig();
  const ts = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
  const backup = `/config/config_${ts}.ini.bak`;
  onStatus(t("Saving a backup of the current configuration…"));
  await upload(backup, new TextEncoder().encode(old));
  onStatus(t("Backup saved as {file}.", { file: backup }));
  const round = await waitRoundEnd((s) => onStatus(t("Waiting for the reading round to finish (device: {s})", { s })));
  onStatus(t("Round finished ({round}). Writing the new configuration…", { round }));
  await upload("/config/config.ini", new TextEncoder().encode(newText));
  onStatus(t("Configuration written and checked (MD5). Restarting the device…"));
  await queued(() => req("/reboot", {}, 10000)).catch(() => {}); // the connection drops on reboot
  return backup;
}

/**
 * After a reboot: stay quiet for the boot window (requests during boot destabilised the
 * device before), then wait for a fresh reading. Returns /json.
 */
export async function waitForReading(onStatus = () => {}, quietMs = 150000, maxMs = 12 * 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < quietMs) {
    onStatus(t("Device is restarting; waiting {n} s before asking it anything", { n: Math.ceil((quietMs - (Date.now() - t0)) / 1000) }));
    await sleep(5000);
  }
  let before = null;
  while (Date.now() - t0 < maxMs) {
    try {
      const v = await readValue();
      const ts = Object.values(v)[0]?.timestamp;
      if (before === null) { before = ts; onStatus(t("Device answers again (last reading {ts}). Waiting for a new reading…", { ts })); }
      else if (ts !== before) return v;
    } catch {
      onStatus(t("Waiting for the device to answer…"));
    }
    await sleep(10000);
  }
  throw new Error(t("no new reading within 12 minutes of the restart"));
}
