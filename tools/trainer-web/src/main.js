// Page logic. TensorFlow.js runs in src/worker.js (keeps going in a background tab);
// device access in device.js, stored project data in store.js.
import { unzip } from "fflate";
import { decodeBrowser, parseCsv, IN_W, IN_H, PIX } from "./dataset.js";
import { resizeBilinear } from "./resize.js";
import { countMacs } from "./arch.js";
import * as dev from "./device.js";
import { getKey, setKey } from "./ini.js";
import * as store from "./store.js";
import { scan, download, groupOf } from "./collect.js";
import { configChecks, coverage, MIN_PER_DIGIT } from "./readiness.js";
import { LABELS, effective, steadyLabels } from "./labels.js";
import * as llm from "./llm.js";
import { buildTrainSet, compareOnTest } from "./trainset.js";
import TrainWorker from "./worker.js?worker&inline";

const $ = (id) => document.getElementById(id);
const S = {
  onDevice: false, cfg: null, checks: [],
  crops: [], labels: new Map(), steady: new Map(), eff: new Map(), cov: null,
  set: null, compare: null, model: null, busy: null, stop: false,
};
const baseTitle = document.title;
const MIN_COMPARE = 100; // test images the device read, needed to call one model better
const DEBUG = location.search.includes("debug");
const tlog = (label, t0) => { if (DEBUG) console.log(`[timing] ${label}: ${(performance.now() - t0).toFixed(0)} ms`); };

// ---------------------------------------------------------------- small UI helpers
function status(id, text, bad = false) {
  const el = $(id); el.textContent = text; el.classList.toggle("bad", bad);
  if (S.busy && (id === S.where || id === "autoStatus")) $("activityText").textContent = `${S.busy}: ${text}`;
}
const setBar = (id, frac) => { $(id).style.width = `${Math.round(Math.max(0, Math.min(1, frac)) * 100)}%`; };
function pill(id, text, kind = "") {
  const el = $(id); el.textContent = text; el.className = `pill ${kind}`;
  const np = document.querySelector(`nav.steps .np[data-for="${id}"]`);
  if (np) { np.textContent = text; np.className = `np ${kind}`; }
  renderSummary();
}
const title = (t) => { document.title = t ? `${t} · ${baseTitle}` : baseTitle; };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const parseSize = (v) => v.split("|").map((s) => s.split(",").map(Number));
// One task at a time: while one runs, every action button (class "act") is disabled.
function lockActions(on) {
  document.querySelectorAll("button.act").forEach((b) => {
    if (on) { b.dataset.was = b.disabled; b.disabled = true; } else if ("was" in b.dataset) { b.disabled = b.dataset.was === "true"; delete b.dataset.was; }
  });
}
const WHERE_STEP = { setupStatus: "setup", collectStatus: "collect", llmStatus: "labels", trainStatus: "train", installStatus: "install", autoStatus: "start" };
function busy(name, where = "autoStatus") {
  if (S.busy) { status(where, `Wait for "${S.busy}" to finish first.`, true); return false; }
  S.busy = name; S.where = where; S.stop = false; $("bgNote").hidden = false; lockActions(true);
  $("activityText").textContent = `${name}…`; $("activity").hidden = false;
  return true;
}
function idle() { S.busy = null; $("bgNote").hidden = true; $("activity").hidden = true; title(""); lockActions(false); renderModel(); }

// ---------------------------------------------------------------- wizard navigation
const STEPS = ["start", "setup", "collect", "labels", "train", "install"];
const STEP_NAMES = { start: "Start", setup: "Device", collect: "Collect", labels: "Labels", train: "Train", install: "Install" };
const STEP_PILL = { setup: "setupPill", collect: "collectPill", labels: "labelsPill", train: "trainPill", install: "installPill" };
function show(step) {
  if (!STEPS.includes(step)) step = "start";
  document.querySelectorAll("section[data-step]").forEach((sec) => { sec.hidden = sec.dataset.step !== step; });
  document.querySelectorAll("nav.steps button").forEach((b) => b.removeAttribute("aria-current"));
  document.querySelector(`nav.steps button[data-step="${step}"]`)?.setAttribute("aria-current", "step");
  if (step !== "labels") $("drawer").hidden = true;
  if (location.hash !== `#${step}`) history.replaceState(null, "", `#${step}`);
  window.scrollTo({ top: 0 });
}
document.querySelectorAll("nav.steps button").forEach((b) => b.addEventListener("click", () => show(b.dataset.step)));
window.addEventListener("hashchange", () => show(location.hash.slice(1)));
$("activityGo").addEventListener("click", () => show(WHERE_STEP[S.where] || "start"));
// Back / Next at the bottom of every step
document.querySelectorAll("section[data-step]").forEach((sec) => {
  const i = STEPS.indexOf(sec.dataset.step);
  const nav = document.createElement("div"); nav.className = "stepnav";
  if (i > 0) {
    const back = document.createElement("button"); back.type = "button";
    back.textContent = `← ${STEP_NAMES[STEPS[i - 1]]}`;
    back.addEventListener("click", () => show(STEPS[i - 1]));
    nav.append(back);
  } else nav.append(document.createElement("span"));
  if (i < STEPS.length - 1) {
    const next = document.createElement("button"); next.type = "button"; next.className = "primary";
    next.textContent = `Next: ${STEP_NAMES[STEPS[i + 1]]} →`;
    next.addEventListener("click", () => show(STEPS[i + 1]));
    nav.append(next);
  }
  sec.append(nav);
});
function renderSummary() {
  const el = $("summary"); if (!el) return;
  el.innerHTML = STEPS.slice(1).map((st, i) =>
    `<button type="button" data-go="${st}">${i + 1} · ${STEP_NAMES[st]}<span>${esc($(STEP_PILL[st])?.textContent || "–")}</span></button>`).join("");
}
$("summary").addEventListener("click", (e) => { const b = e.target.closest("button[data-go]"); if (b) show(b.dataset.go); });

// ---------------------------------------------------------------- worker
const worker = new TrainWorker();
const waiters = {};
const once = (type) => new Promise((res, rej) => { waiters[type] = { res, rej }; });
worker.onmessage = ({ data: m }) => {
  if (m.type === "progress") onTrainProgress(m);
  else if (m.type === "epoch") onEpoch(m);
  else if (m.type === "error") {
    const w = Object.values(waiters)[0];
    Object.keys(waiters).forEach((k) => delete waiters[k]);
    w?.rej(new Error(m.message));
  } else if (waiters[m.type]) { const w = waiters[m.type]; delete waiters[m.type]; w.res(m); }
};

// ---------------------------------------------------------------- 1. setup
async function refreshSetup() {
  if (!S.onDevice) {
    pill("setupPill", "not on a device", "warn");
    $("checks").innerHTML = `<li class="lv-warn"><span class="dot"></span><span class="t">This page is not served by an AI-on-the-edge device</span>
      <span class="d">Upload trainer.html.gz to /html/ on the device and open http://&lt;device&gt;/trainer.html to collect images and install models. Importing a dataset zip and training work here too.</span></li>`;
    return;
  }
  try {
    S.cfg = await dev.readConfig();
  } catch (e) { status("setupStatus", `Could not read the configuration: ${e.message}`, true); return; }
  S.checks = configChecks(S.cfg);
  const worst = S.checks.some((c) => c.level === "block") ? "block" : S.checks.some((c) => c.level === "warn") ? "warn" : "ok";
  pill("setupPill", { block: "action needed", warn: "check", ok: "ready" }[worst], { block: "bad", warn: "warn", ok: "ok" }[worst]);
  $("checks").innerHTML = S.checks.map((c, i) => `<li class="lv-${c.level}"><span class="dot"></span><span class="t">${esc(c.title)}</span>
    ${c.fix ? `<button class="primary act" data-fix="${i}">${esc(c.fix.label)}</button>` : "<span></span>"}
    <span class="d">${esc(c.detail || "")}</span>
    ${c.fix ? `<span class="confirm d" data-confirm="${i}" hidden>This changes the configuration and restarts the device once.
      <button class="primary act" data-yes="${i}">Change and restart</button><button data-no="${i}">Cancel</button></span>` : ""}</li>`).join("");
}
$("checks").addEventListener("click", async (e) => {
  const b = e.target.closest("button"); if (!b) return;
  const i = b.dataset.fix ?? b.dataset.yes ?? b.dataset.no;
  const box = $("checks").querySelector(`[data-confirm="${i}"]`);
  if (b.dataset.fix) { box.hidden = false; return; }
  if (b.dataset.no) { box.hidden = true; return; }
  if (!busy("device setup", "setupStatus")) return;
  try {
    const next = S.checks[i].fix.apply(S.cfg);
    const backup = await dev.writeConfigAndReboot(next, (s) => status("setupStatus", s));
    await dev.waitForReading((s) => status("setupStatus", s));
    status("setupStatus", `Done. The previous configuration is saved as ${backup}.`);
  } catch (err) {
    status("setupStatus", `The change did not complete: ${err.message}`, true);
  } finally { idle(); refreshSetup(); }
});

// ---------------------------------------------------------------- project data
async function refreshProject() {
  let t0 = performance.now();
  S.crops = await store.allCrops(); tlog(`allCrops ${S.crops.length}`, t0); t0 = performance.now();
  S.labels = await store.allLabels(); tlog("allLabels", t0); t0 = performance.now();
  S.steady = steadyLabels(S.crops); tlog("steady", t0); t0 = performance.now();
  S.eff = new Map(S.crops.map((c) => [c.id, effective(c, S.labels.get(c.id), S.steady)]));
  S.cov = coverage(S.crops, S.eff); tlog("effective+coverage", t0); t0 = performance.now();
  renderCoverage();
  const rois = S.cov.rois.map((r) => r.roi);
  const sel = $("revRoi").value;
  $("revRoi").innerHTML = `<option value="">All</option>` + rois.map((r) => `<option ${r === sel ? "selected" : ""}>${esc(r)}</option>`).join("");
  pill("collectPill", S.crops.length ? `${S.crops.length.toLocaleString()} images` : "empty", S.crops.length ? "ok" : "");
  renderReview(true);
  const est = await store.usage();
  if (est && !S.busy) status("collectStatus", `${S.crops.length.toLocaleString()} images stored in this browser` +
    (est.usage ? ` (${(est.usage / 1e6).toFixed(0)} MB used)` : ""));
}

function renderCoverage() {
  const c = S.cov;
  if (!c.rois.length) { $("coverage").innerHTML = `<p class="hint">No images yet. Collect them in step 2.</p>`; status("verdict", ""); pill("labelsPill", "–"); return; }
  const head = `<tr><th>Wheel</th><th>Images</th><th>Days</th><th>Usable</th><th>To review</th>${LABELS.map((l) => `<th>${l}</th>`).join("")}</tr>`;
  const body = c.rois.map((g) => `<tr><td>${esc(g.roi)}${g.rolling ? " ↻" : ""}</td><td>${g.crops}</td><td>${g.days}</td><td>${g.usable}</td><td>${g.review}</td>${
    LABELS.map((l, i) => { const n = g.labels[l]; const need = i < 10 || g.rolling; return `<td class="${!need ? "" : n === 0 ? "lo" : n < 15 ? "mid" : ""}">${n}</td>`; }).join("")}</tr>`).join("");
  $("coverage").innerHTML = `<table><thead>${head}</thead><tbody>${body}</tbody></table>
    <p class="hint">Usable images per label (your labels and confirmed ones). ↻ = a rolling wheel that often stops between two digits, so its in-between positions are needed too.</p>`;
  if (c.verdict === "ready") { pill("labelsPill", "ready to train", "ok"); status("verdict", `Enough data: every digit has at least ${MIN_PER_DIGIT} usable images over ${c.days} days.`); }
  else if (c.verdict === "not-enough") {
    pill("labelsPill", "not enough yet", "warn");
    status("verdict", `Not enough yet${c.days < 2 ? ` (only ${c.days} day of images)` : ""}. Missing: ${c.missing.slice(0, 8).join(", ")}${c.missing.length > 8 ? ` and ${c.missing.length - 8} more` : ""}. ` +
      "Collect more days, or label images in the review below. You can still train, with weaker results.");
  }
}

// ---------------------------------------------------------------- 2. collect
let plan = null;
const fmtTime = (sec) => (sec < 90 ? `${Math.max(1, Math.round(sec))} s` : sec < 5400 ? `${Math.round(sec / 60)} min` : `${(sec / 3600).toFixed(1)} h`);
const FILES_PER_S = 3; // what an ESP32-CAM serves; the measured rate replaces it while downloading

function renderPlan(p) {
  const box = $("plan");
  if (!p) { box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = `<div><b>${p.toFetch.toLocaleString()}</b><span>new images to download</span></div>
    <div><b>about ${fmtTime(p.toFetch / FILES_PER_S)}</b><span>at about ${FILES_PER_S} images/s</span></div>
    <div><b>${p.onDevice.toLocaleString()}</b><span>images in ${p.listed} new hour folders on the device</span></div>
    <div><b>${p.skippedEnough.toLocaleString()}</b><span>skipped: enough images of that reading already</span></div>
    <div><b>${p.have.toLocaleString()}</b><span>already here${p.knownHours ? `, plus ${p.knownHours} hours collected earlier` : ""}</span></div>
    <details class="pw"><summary>Per wheel</summary><div class="tw">${perWheelTable(p)}</div></details>`;
  $("btnCollect").disabled = !p.toFetch;
  $("btnCollect").textContent = p.toFetch ? `Download ${p.toFetch.toLocaleString()} images` : "Nothing new to download";
}
function perWheelTable(p) {
  const w = new Map();
  for (const [g, v] of p.groups) {
    const [roi, lab] = g.split("|");
    const e = w.get(roi) || { roi, picked: 0, skipped: 0, full: 0, open: 0 };
    e.picked += v.picked; e.skipped += v.available - v.picked;
    if (v.have + v.picked >= +$("quota").value) e.full++; else if (lab !== "rejected") e.open++;
    w.set(roi, e);
  }
  const rows = [...w.values()].sort((a, b) => a.roi.localeCompare(b.roi, undefined, { numeric: true }))
    .map((e) => `<tr><td>${esc(e.roi)}</td><td>${e.picked}</td><td>${e.skipped}</td><td>${e.full}</td><td>${e.open}</td></tr>`).join("");
  return `<table><thead><tr><th>Wheel</th><th>To download</th><th>Skipped</th><th>Readings full</th><th>Readings still short</th></tr></thead><tbody>${rows}</tbody></table>`;
}
/** Crops already stored per download group (wheel + device reading). */
function haveByGroup() {
  const m = new Map();
  for (const c of S.crops) if (c.pred != null) { const g = groupOf(c.roi, c.pred, c.rejected); m.set(g, (m.get(g) || 0) + 1); }
  return m;
}
async function runScan() {
  if (!S.onDevice) { status("collectStatus", "Collecting needs the page to be opened from the device.", true); return null; }
  status("collectStatus", "Listing the device's image folders…");
  plan = await scan({
    days: +$("days").value || 7, quota: +$("quota").value || 100, have: haveByGroup(), shouldStop: () => S.stop,
    onProgress: (p) => {
      status("collectStatus", `Listing folder ${p.listed + 1} of ${p.total} (${p.folder})…`);
      setBar("collectBar", p.listed / Math.max(1, p.total)); title(`checking ${p.listed}/${p.total}`);
    },
  });
  setBar("collectBar", 0);
  renderPlan(plan);
  status("collectStatus", plan.complete ? `Checked ${plan.listed} new hour folders in ${fmtTime(plan.listSeconds)}.` : "Check stopped early; the numbers cover the folders listed so far.");
  return plan;
}
async function runDownload() {
  if (!plan) await runScan();
  if (!plan?.toFetch) return;
  await store.persist();
  const res = await download(plan, {
    shouldStop: () => S.stop,
    onProgress: (p) => {
      const left = p.total - p.fetched - p.failed;
      setBar("collectBar", (p.fetched + p.failed) / Math.max(1, p.total));
      status("collectStatus", `${p.fetched.toLocaleString()} of ${p.total.toLocaleString()} downloaded${p.failed ? `, ${p.failed} failed` : ""} · ${p.rate.toFixed(1)} images/s · about ${fmtTime(left / Math.max(0.1, p.rate))} left`);
      title(`collecting ${Math.round(((p.fetched + p.failed) / Math.max(1, p.total)) * 100)}%`);
    },
  });
  status("collectStatus", `${S.stop ? "Stopped" : "Done"}: ${res.fetched.toLocaleString()} new images${res.failed ? `, ${res.failed} could not be read` : ""}.`);
  plan = null; renderPlan(null); $("btnCollect").textContent = "Download"; $("btnCollect").disabled = true;
  await refreshProject();
}
async function runCollect() { await runScan(); if (!S.stop) await runDownload(); }

$("btnScan").addEventListener("click", async () => {
  if (!busy("checking the device", "collectStatus")) return;
  $("btnCollectStop").disabled = false;
  try { await runScan(); } catch (e) { status("collectStatus", `Checking failed: ${e.message}`, true); }
  finally { idle(); $("btnCollectStop").disabled = true; $("btnCollect").disabled = !plan?.toFetch; }
});
$("btnCollect").addEventListener("click", async () => {
  if (!busy("collect", "collectStatus")) return;
  $("btnCollectStop").disabled = false;
  try { await runDownload(); } catch (e) { status("collectStatus", `Collecting failed: ${e.message}`, true); }
  finally { idle(); $("btnCollectStop").disabled = true; $("btnCollect").disabled = !plan?.toFetch; }
});
$("btnCollectStop").addEventListener("click", () => { S.stop = true; });

$("btnImport").addEventListener("click", () => $("fileZip").click());
$("fileZip").addEventListener("change", async (e) => {
  const f = e.target.files[0]; if (!f || !busy("import", "collectStatus")) return;
  try {
    status("collectStatus", `Reading ${f.name}…`);
    const buf = new Uint8Array(await f.arrayBuffer());
    const files = await new Promise((res, rej) => unzip(buf, (err, out) => (err ? rej(err) : res(out))));
    if (!files["labels.csv"]) throw new Error("labels.csv is missing from the zip");
    const rows = parseCsv(new TextDecoder().decode(files["labels.csv"])).filter((r) => r.label);
    let batch = [], labels = [], n = 0;
    for (const r of rows) {
      const bytes = files[r.path]; if (!bytes) continue;
      try {
        const im = await decodeBrowser(bytes);
        const id = `zip/${f.name}/${r.path}`;
        const roi = r.src ? `${r.src}.dig${r.pos}` : `dig${r.pos}`;
        batch.push({ crop: { id, roi, ts: r.ts || "00000000-000000", pred: null, rejected: false, w: im.width, h: im.height,
          pix: resizeBilinear(im.data, im.width, im.height, IN_W, IN_H, 4) }, jpeg: bytes });
        labels.push({ id, human: r.label });
      } catch { /* skip unreadable */ }
      if (batch.length >= 200) { await store.putCrops(batch); await store.putLabels(labels); n += batch.length; batch = []; labels = []; status("collectStatus", `Imported ${n} of ${rows.length}…`); }
    }
    if (batch.length) { await store.putCrops(batch); await store.putLabels(labels); n += batch.length; }
    status("collectStatus", `Imported ${n} labelled images from ${f.name}.`);
    await refreshProject();
  } catch (err) { status("collectStatus", `Import failed: ${err.message || err}`, true); }
  finally { idle(); e.target.value = ""; }
});

$("btnClear").addEventListener("click", () => { $("clearConfirm").hidden = false; });
$("btnClearNo").addEventListener("click", () => { $("clearConfirm").hidden = true; });
$("btnClearYes").addEventListener("click", async () => {
  $("clearConfirm").hidden = true;
  await store.clearAll(); S.model = null; await refreshProject(); status("collectStatus", "All data in this browser deleted.");
});

// ---------------------------------------------------------------- 3. labels: AI server
const llmSettings = () => ({ provider: $("llmProvider").value, url: $("llmUrl").value.trim(), model: $("llmModel").value.trim(), key: $("llmKey").value });
async function loadLlmSettings() {
  const s = await store.kvGet("llm");
  if (s) { $("llmProvider").value = s.provider; $("llmUrl").value = s.url; $("llmModel").value = s.model; $("llmKey").value = s.key || ""; }
  document.querySelectorAll(".origin").forEach((e) => { e.textContent = location.origin; });
}
["llmProvider", "llmUrl", "llmModel", "llmKey"].forEach((id) => $(id).addEventListener("change", () => store.kvSet("llm", llmSettings())));
$("llmProvider").addEventListener("change", () => {
  if ($("llmProvider").value === "ollama" && !/11434/.test($("llmUrl").value)) $("llmUrl").value = "http://localhost:11434";
  if ($("llmProvider").value === "openai" && /11434/.test($("llmUrl").value)) $("llmUrl").value = "https://api.openai.com";
});
$("llmBox").addEventListener("toggle", async () => {
  if (!$("llmBox").open) return;
  try { $("llmModels").innerHTML = (await llm.listModels(llmSettings())).map((m) => `<option value="${esc(m)}">`).join(""); } catch { /* shown on test */ }
});

function llmQueue(limit) {
  const s = llmSettings();
  const rank = { conflict: 0, unconfirmed: 1, confirmed: 2 };
  return S.crops.filter((c) => { const r = S.labels.get(c.id); const e = S.eff.get(c.id); return !r?.human && !(r?.llm && r.llmModel === s.model) && e && e.status in rank; })
    .sort((a, b) => rank[S.eff.get(a.id).status] - rank[S.eff.get(b.id).status] || (a.ts < b.ts ? 1 : -1))
    .slice(0, limit);
}
$("btnLlmTest").addEventListener("click", async () => {
  const c = llmQueue(1)[0] || S.crops[0];
  if (!c) { status("llmStatus", "Collect images first.", true); return; }
  status("llmStatus", "Asking…");
  try {
    const r = await llm.ask(llmSettings(), await llm.encodeCrop(await store.getJpeg(c.id)));
    status("llmStatus", `Works: answered "${r.answer}" for a ${c.roi} image in ${r.seconds.toFixed(1)} s (device read ${c.pred ?? "–"}).`);
  } catch (e) { status("llmStatus", e.message, true); }
});
async function runLlm(limit) {
  const s = llmSettings();
  await store.kvSet("llm", s);
  const q = llmQueue(limit);
  if (!q.length) { status("llmStatus", "Nothing left to ask about."); return; }
  const t0 = performance.now();
  let done = 0, failed = 0;
  for (const c of q) {
    if (S.stop) break;
    try {
      const r = await llm.ask(s, await llm.encodeCrop(await store.getJpeg(c.id)));
      await store.setLabel(c.id, { llm: r.answer, llmModel: s.model });
      const rec = { ...(S.labels.get(c.id) || { id: c.id }), llm: r.answer, llmModel: s.model };
      S.labels.set(c.id, rec);
      S.eff.set(c.id, effective(c, rec, S.steady));
      done++;
    } catch (e) {
      failed++;
      if (failed >= 3 && done === 0) throw e;
    }
    const per = (performance.now() - t0) / 1000 / (done + failed);
    status("llmStatus", `${done} of ${q.length} labelled${failed ? `, ${failed} failed` : ""}, ${per.toFixed(1)} s each, about ${Math.ceil(((q.length - done - failed) * per) / 60)} min left`);
    title(`AI labels ${done}/${q.length}`);
  }
  status("llmStatus", `${S.stop ? "Stopped" : "Done"}: ${done} images labelled by ${s.model}${failed ? `, ${failed} failed` : ""}.`);
  await refreshProject();
}
$("btnLlm").addEventListener("click", async () => {
  if (!busy("AI labelling", "llmStatus")) return;
  $("btnLlm").disabled = true; $("btnLlmStop").disabled = false;
  try { await runLlm(+$("llmN").value || 200); } catch (e) { status("llmStatus", e.message, true); }
  finally { idle(); $("btnLlm").disabled = false; $("btnLlmStop").disabled = true; }
});
$("btnLlmStop").addEventListener("click", () => { S.stop = true; });

// ---------------------------------------------------------------- 3. labels: review
const REV_PAGE = 96;
let rev = { list: [], shown: REV_PAGE, sel: -1, urls: [] , tPending: false };
function reviewList() {
  const roi = $("revRoi").value, st = $("revStatus").value;
  return S.crops.filter((c) => {
    if (roi && c.roi !== roi) return false;
    const e = S.eff.get(c.id);
    if (st === "review") return e.status === "unconfirmed" || e.status === "conflict";
    if (st === "conflict") return e.status === "conflict";
    if (st === "human") return e.status === "human" || e.status === "excluded";
    return true;
  }).sort((a, b) => S.eff.get(a.id).score - S.eff.get(b.id).score || (a.ts < b.ts ? 1 : -1));
}
function renderReview(reset) {
  if (reset) { rev.list = reviewList(); rev.shown = REV_PAGE; rev.sel = -1; $("drawer").hidden = true; }
  rev.urls.forEach((u) => URL.revokeObjectURL(u)); rev.urls = [];
  const g = $("revGrid"); g.textContent = "";
  rev.list.slice(0, rev.shown).forEach((c, k) => g.append(tile(c, k)));
  $("revMore").hidden = rev.shown >= rev.list.length;
  $("revMore").textContent = `Show more (${rev.list.length - rev.shown} left)`;
  if (!rev.list.length) g.innerHTML = `<p class="hint">Nothing to show here.</p>`;
}
function tile(c, k) {
  const e = S.eff.get(c.id);
  const t = document.createElement("button");
  t.type = "button"; t.className = `tile st-${e.status}`; t.dataset.k = k;
  t.setAttribute("aria-selected", k === rev.sel ? "true" : "false");
  const img = document.createElement("img"); img.alt = ""; img.loading = "lazy";
  store.getJpeg(c.id).then((b) => { if (!b) return; const u = URL.createObjectURL(new Blob([b], { type: "image/jpeg" })); rev.urls.push(u); img.src = u; });
  const l = document.createElement("span"); l.className = "l"; l.textContent = e.status === "excluded" ? "x" : (e.label ?? "?");
  const s = document.createElement("span"); s.className = "s"; s.textContent = `${c.roi} · ${e.sources}`;
  t.append(img, l, s);
  t.addEventListener("click", () => select(k));
  return t;
}
function select(k) {
  const prev = rev.sel; rev.sel = k; rev.tPending = false;
  const g = $("revGrid");
  if (k >= rev.shown) { rev.shown = Math.ceil((k + 1) / REV_PAGE) * REV_PAGE; renderReview(false); }
  g.querySelector(`[data-k="${prev}"]`)?.setAttribute("aria-selected", "false");
  const el = g.querySelector(`[data-k="${k}"]`);
  el?.setAttribute("aria-selected", "true"); el?.scrollIntoView({ block: "nearest" });
  drawer();
}
async function drawer() {
  const c = rev.list[rev.sel];
  if (!c) { $("drawer").hidden = true; return; }
  $("drawer").hidden = false;
  const e = S.eff.get(c.id), r = S.labels.get(c.id) || {};
  const b = await store.getJpeg(c.id);
  if (b) { const u = URL.createObjectURL(new Blob([b], { type: "image/jpeg" })); $("bigImg").onload = () => URL.revokeObjectURL(u); $("bigImg").src = u; }
  status("selInfo", `${c.roi}  ${c.ts}  label ${e.status === "excluded" ? "x" : e.label ?? "?"} (${e.sources})  device ${c.pred ?? "–"}${c.rejected ? " rejected" : ""}  AI ${r.llm ?? "–"}`);
  const keys = $("keys"); keys.textContent = "";
  [...LABELS, "x"].forEach((l, i) => {
    if (i === 10 || i === 20) { const sp = document.createElement("span"); sp.className = "sep"; keys.append(sp); }
    const bt = document.createElement("button"); bt.type = "button"; bt.textContent = l === "x" ? "X unusable" : l;
    if ((r.human || (e.status !== "excluded" && e.label)) === l || (l === "x" && e.status === "excluded")) bt.classList.add("on");
    bt.addEventListener("click", () => setHuman(c, l));
    keys.append(bt);
  });
  const rm = document.createElement("button"); rm.type = "button"; rm.textContent = "Remove my label"; rm.disabled = !r.human;
  rm.addEventListener("click", () => setHuman(c, null)); keys.append(rm);
}
async function setHuman(c, l) {
  await store.setLabel(c.id, { human: l });
  const rec = { ...(S.labels.get(c.id) || { id: c.id }) };
  if (l === null) delete rec.human; else rec.human = l;
  S.labels.set(c.id, rec);
  S.eff.set(c.id, effective(c, rec, S.steady));
  const old = $("revGrid").querySelector(`[data-k="${rev.sel}"]`);
  if (old) old.replaceWith(tile(c, rev.sel));
  drawer();
}
$("revRoi").addEventListener("change", () => renderReview(true));
$("revStatus").addEventListener("change", () => renderReview(true));
$("revMore").addEventListener("click", () => { rev.shown += REV_PAGE; renderReview(false); });
document.addEventListener("keydown", (e) => {
  if ($("drawer").hidden || /INPUT|SELECT|TEXTAREA/.test(e.target.tagName) || e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key, c = rev.list[rev.sel];
  const next = () => setTimeout(() => select(Math.min(rev.list.length - 1, rev.sel + 1)), 80);
  if (k === "ArrowRight" || k === "ArrowDown") { e.preventDefault(); select(Math.min(rev.list.length - 1, rev.sel + 1)); return; }
  if (k === "ArrowLeft" || k === "ArrowUp") { e.preventDefault(); select(Math.max(0, rev.sel - 1)); return; }
  if (!c) return;
  if (k === "Escape") { $("drawer").hidden = true; return; }
  if (k === "t" || k === "T") { rev.tPending = true; status("selInfo", "Between two digits: press the lower one (T 6 = 6/7)"); return; }
  if (/^[0-9]$/.test(k)) { e.preventDefault(); const l = rev.tPending ? `${k}/${(+k + 1) % 10}` : k; rev.tPending = false; setHuman(c, l).then(next); return; }
  if (k === "x" || k === "X") { setHuman(c, "x").then(next); return; }
  if (k === "Enter") { const lab = S.eff.get(c.id).label; if (lab) setHuman(c, lab).then(next); return; }
  if (k === "Backspace") { e.preventDefault(); setHuman(c, null); }
});

// ---------------------------------------------------------------- 4. train
let trainCtx = { epochs: 1, history: [] };
function onTrainProgress(m) {
  const frac = (m.epoch + m.step / m.steps) / trainCtx.epochs;
  setBar("trainBar", frac); title(`${Math.round(frac * 100)}% training`);
}
function onEpoch(e) {
  trainCtx.history.push(e); drawChart();
  status("trainStatus", `Epoch ${e.epoch + 1}/${e.epochs}  loss ${e.loss.toFixed(3)}  validation loss ${e.valLoss.toFixed(3)}  ` +
    `validation accuracy ${(e.valAcc * 100).toFixed(1)}%  ${e.seconds.toFixed(1)} s/epoch  about ${Math.ceil(((e.epochs - e.epoch - 1) * e.seconds) / 60)} min left`);
}
function drawChart() {
  const c = $("chart"), ctx = c.getContext("2d"), W = c.width, H = c.height, h = trainCtx.history;
  const css = getComputedStyle(document.documentElement);
  ctx.clearRect(0, 0, W, H);
  if (!h.length) return;
  const max = Math.max(...h.map((e) => Math.max(e.loss, e.valLoss)));
  const x = (i) => 30 + (i / Math.max(1, trainCtx.epochs - 1)) * (W - 40), y = (v) => H - 14 - (v / max) * (H - 28);
  ctx.fillStyle = css.getPropertyValue("--muted"); ctx.font = "11px sans-serif";
  ctx.fillText(max.toFixed(2), 2, 14); ctx.fillText("0", 2, H - 10);
  for (const [key, color] of [["loss", "--accent"], ["valLoss", "--warn"]]) {
    ctx.strokeStyle = css.getPropertyValue(color); ctx.lineWidth = 2; ctx.beginPath();
    h.forEach((e, i) => (i ? ctx.lineTo(x(i), y(e[key])) : ctx.moveTo(x(i), y(e[key])))); ctx.stroke();
  }
}

async function runTrain() {
  const tb = performance.now();
  const set = buildTrainSet(S.crops, S.eff, { includeUnconfirmed: $("useUnconfirmed").checked });
  tlog(`buildTrainSet train ${set.trainIdx.length} test ${set.testIdx.length}`, tb);
  if (set.trainIdx.length < 200) throw new Error(`only ${set.trainIdx.length} usable training images; collect or label more first`);
  const [filters, dense] = parseSize($("size").value);
  const epochs = +$("epochs").value || 60;
  trainCtx = { epochs, history: [] };
  status("trainStatus", `Training on ${set.trainIdx.length.toLocaleString()} images, testing on ${set.testIdx.length.toLocaleString()} from the newest days…`);
  worker.postMessage({ type: "data", X: set.X, Y: set.Y.slice() }, [set.X.buffer]);
  const t0 = performance.now();
  const done = once("trained");
  worker.postMessage({ type: "train", filters, dense, epochs, batch: +$("batch").value || 64, lr: +$("lr").value || 1e-3,
    trainIdx: set.trainIdx, valIdx: set.valIdx, testIdx: set.testIdx });
  const res = await done;
  setBar("trainBar", 1);
  S.set = set; S.compare = compareOnTest(set, res.probs);
  // export right away (calibration on 300 training images)
  const name = `dig-browser-f${filters[0]}_${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}_q.tflite`;
  const ex = once("exported");
  worker.postMessage({ type: "export", name, calibIdx: set.trainIdx.slice(0, 300) });
  const { bytes } = await ex;
  const tot = S.compare.reduce((a, e) => ({ n: a.n + e.n, m: a.m + e.model, d: a.d + e.dev, dn: a.dn + e.devN, md: a.md + e.modelOnDev }),
    { n: 0, m: 0, d: 0, dn: 0, md: 0 });
  // compare with the installed model on the same images, and only with enough of them
  const fair = tot.dn >= MIN_COMPARE;
  S.model = { name, bytes, at: Date.now(), acc: tot.n ? tot.m / tot.n : null, compareN: tot.dn,
    accOnDev: fair ? tot.md / tot.dn : null, devAcc: fair ? tot.d / tot.dn : null };
  await store.kvSet("lastModel", S.model);
  status("trainStatus", `Done in ${((performance.now() - t0) / 60000).toFixed(1)} min (kept epoch ${res.bestEpoch + 1}). Model ${(bytes.length / 1024).toFixed(0)} KB.`);
  renderCompare(); renderModel();
  return S.model;
}
/** better | worse | unknown (too few test images the device read itself) */
function verdictOf(m) {
  if (!m || m.devAcc == null) return "unknown";
  return m.accOnDev >= m.devAcc - 0.002 ? "better" : "worse";
}
function renderCompare() {
  const pct = (a, n) => (n ? `${((a / n) * 100).toFixed(1)}%` : "–");
  const cls = (a, n) => (!n ? "" : a / n < 0.95 ? "lo" : a / n < 0.99 ? "mid" : "ok");
  const rows = S.compare.map((e) => `<tr><td>${esc(e.roi)}</td><td>${e.n}</td><td class="${cls(e.model, e.n)}">${pct(e.model, e.n)}</td>` +
    `<td class="${cls(e.dev, e.devN)}">${pct(e.dev, e.devN)}</td><td>${e.t}</td><td>${pct(e.tModel, e.t)}</td></tr>`).join("");
  const m = S.model;
  $("evalTable").innerHTML = `<table><thead><tr><th>Wheel</th><th>Test images</th><th>New model</th><th>Device now</th><th>Between digits</th><th>New model</th></tr></thead><tbody>${rows}</tbody></table>
    <p class="hint">Test images come from the newest days and were not used for training. "Device now" is what the installed model read on the same images. ${
      m?.devAcc != null ? `On the ${m.compareN} test images the device read itself: new ${(m.accOnDev * 100).toFixed(1)}%, installed ${(m.devAcc * 100).toFixed(1)}%. Where the label came from the device, the installed model's score is flattered.`
        : `Only ${m?.compareN ?? 0} test image${(m?.compareN ?? 0) === 1 ? " was" : "s were"} read by the device (${MIN_COMPARE} needed), so the two models are not compared; collect more days.`}</p>`;
  const v = verdictOf(m);
  pill("trainPill", m ? { better: "new model ready", worse: "not better", unknown: "not compared" }[v] : "–", m ? { better: "ok", worse: "warn", unknown: "" }[v] : "");
}
$("btnTrain").addEventListener("click", async () => {
  if (!busy("training", "trainStatus")) return;
  $("btnTrain").disabled = true; $("btnStop").disabled = false;
  try { await runTrain(); } catch (e) { status("trainStatus", `Training failed: ${e.message}`, true); }
  finally { idle(); $("btnTrain").disabled = false; $("btnStop").disabled = true; }
});
$("btnStop").addEventListener("click", () => { S.stop = true; worker.postMessage({ type: "stop" }); });

// ---------------------------------------------------------------- 5. install
function renderModel() {
  const m = S.model;
  $("btnInstall").disabled = !m || !S.onDevice; $("btnDownload").disabled = !m;
  if (m) $("fname").value = m.name;
  pill("installPill", m ? `model of ${new Date(m.at).toLocaleString()}` : "no model yet", m ? "" : "");
}
$("btnDownload").addEventListener("click", () => {
  const m = S.model; if (!m) return;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([m.bytes], { type: "application/octet-stream" }));
  a.download = $("fname").value.trim() || m.name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
});
$("btnInstall").addEventListener("click", () => {
  const m = S.model;
  const cur = S.cfg ? getKey(S.cfg, "Digits", "Model")?.value : "?";
  $("installConfirmText").textContent = `Replace ${cur} with ${$("fname").value.trim() || m.name}? The device restarts once.` +
    (m.devAcc != null ? ` Test images: new ${(m.accOnDev * 100).toFixed(1)}%, current ${(m.devAcc * 100).toFixed(1)}%.` : " The models were not compared (too few test images from this device).");
  $("installConfirm").hidden = false;
});
$("btnInstallNo").addEventListener("click", () => { $("installConfirm").hidden = true; });
$("btnInstallYes").addEventListener("click", async () => {
  $("installConfirm").hidden = true;
  if (!busy("install", "installStatus")) return;
  try { await runInstall(); } catch (e) { status("installStatus", `Install did not complete: ${e.message}`, true); }
  finally { idle(); refreshSetup(); }
});

async function runInstall() {
  const m = S.model;
  const name = ($("fname").value.trim() || m.name).replace(/[^\w.-]/g, "_");
  const path = `/config/${name.endsWith(".tflite") ? name : `${name}.tflite`}`;
  status("installStatus", `Uploading ${path}…`);
  await dev.upload(path, m.bytes);
  const cfg = await dev.readConfig();
  const prev = getKey(cfg, "Digits", "Model")?.value;
  const backup = await dev.writeConfigAndReboot(setKey(cfg, "Digits", "Model", path), (s) => status("installStatus", s));
  const v = await dev.waitForReading((s) => status("installStatus", s));
  const first = Object.values(v)[0];
  const hist = await store.kvGet("installs", []);
  hist.push({ at: Date.now(), model: path, prev, backup });
  await store.kvSet("installs", hist);
  status("installStatus", `Installed. First reading with ${path}: ${first?.value} (${first?.error}). Previous model: ${prev}; configuration copy: ${backup}.`);
  pill("installPill", "installed", first?.error === "no error" ? "ok" : "warn");
  showUndo();
}
async function showUndo() {
  const last = (await store.kvGet("installs", [])).at(-1);
  $("btnUndo").hidden = !last || !S.onDevice;
  if (last) $("btnUndo").textContent = `Go back to ${last.prev.split("/").pop()}`;
}
$("btnUndo").addEventListener("click", async () => {
  if (!busy("undo", "installStatus")) return;
  try {
    const hist = await store.kvGet("installs", []);
    const last = hist.at(-1);
    const cfg = await dev.readConfig();
    await dev.writeConfigAndReboot(setKey(cfg, "Digits", "Model", last.prev), (s) => status("installStatus", s));
    const v = await dev.waitForReading((s) => status("installStatus", s));
    hist.pop(); await store.kvSet("installs", hist);
    status("installStatus", `Back on ${last.prev}. Reading: ${Object.values(v)[0]?.value}.`);
  } catch (e) { status("installStatus", `Undo did not complete: ${e.message}`, true); }
  finally { idle(); showUndo(); refreshSetup(); }
});

// ---------------------------------------------------------------- automatic run
$("btnAuto").addEventListener("click", async () => {
  if (!busy("automatic run")) return;
  $("btnAuto").disabled = true; $("btnAutoStop").disabled = false;
  const say = (t, bad) => status("autoStatus", t, bad);
  try {
    if (S.onDevice) {
      await refreshSetup();
      if (S.checks.some((c) => c.level === "block")) throw new Error("fix the device setup in step 1 first");
      say("Step 2: collecting new images…"); await runCollect();
    }
    if (S.stop) throw new Error("stopped");
    if ($("autoLlm").checked) { say("Step 3: asking the AI server for labels…"); await runLlm(+$("autoLlmN").value || 200); }
    if (S.stop) throw new Error("stopped");
    if (S.cov.verdict === "blocked") throw new Error("no images to train on");
    say(`Step 4: training${S.cov.verdict === "not-enough" ? " (with less data than recommended)" : ""}…`);
    const m = await runTrain();
    if (S.stop) throw new Error("stopped");
    const v = verdictOf(m);
    if (v === "worse") { say(`Finished. On the same test images the new model read ${(m.accOnDev * 100).toFixed(1)}%, the installed one ${(m.devAcc * 100).toFixed(1)}%: not installed.`); return; }
    if (v === "unknown") { say(`Finished. Too few test images from this device to compare with the installed model (${m.compareN} of ${MIN_COMPARE}), so it was not installed automatically. Install it in step 5 if you want.`); return; }
    if (!$("autoInstall").checked || !S.onDevice) { say("Finished. The new model is ready to install in step 5."); return; }
    say("Step 5: installing the new model…"); await runInstall();
    say("Finished: the new model is installed and reading.");
  } catch (e) { say(`Automatic run stopped: ${e.message}`, e.message !== "stopped"); }
  finally { idle(); $("btnAuto").disabled = false; $("btnAutoStop").disabled = true; }
});
$("btnAutoStop").addEventListener("click", () => { S.stop = true; worker.postMessage({ type: "stop" }); });
window.addEventListener("beforeunload", (e) => { if (S.busy) { e.preventDefault(); e.returnValue = ""; } });

// ---------------------------------------------------------------- start
async function init() {
  show(location.hash.slice(1) || "start");
  for (const o of $("size").options) {
    const [f, d] = parseSize(o.value);
    o.textContent = o.textContent.replace(/[\d.]+ M ops/, `${(countMacs({ filters: f, dense: d }) / 1e6).toFixed(1)} M ops`);
  }
  const ready = once("ready"); worker.postMessage({ type: "init" });
  ready.then(({ backend }) => { $("bBackend").textContent = backend === "webgl" ? "GPU (WebGL)" : "CPU only: training will be slow"; });
  const d = await dev.detect();
  S.onDevice = d.ok;
  $("bDevice").textContent = d.ok ? `device ${location.host} · ${d.status}` : "not on a device";
  await loadLlmSettings();
  S.model = await store.kvGet("lastModel");
  renderModel();
  await Promise.all([refreshSetup(), refreshProject()]);
  showUndo();
  renderSummary();
}
init();
