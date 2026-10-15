// Page logic. TensorFlow.js runs in src/worker.js (keeps going in a background tab);
// device access in device.js, stored project data in store.js.
import "./fonts.css";
import { unzip, zip } from "fflate";
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
import { initHints, pillHint, HINT, statusHint, MIN_COMPARE } from "./hints.js";
import { t, LANG, LANGS, setLang, translatePage } from "./i18n.js";
import TrainWorker from "./worker.js?worker&inline";

const $ = (id) => document.getElementById(id);
const S = {
  onDevice: false, cfg: null, checks: [],
  crops: [], labels: new Map(), steady: new Map(), eff: new Map(), cov: null,
  set: null, compare: null, model: null, busy: null, stop: false,
};
translatePage();
const baseTitle = document.title;
const DEBUG = location.search.includes("debug");
const tlog = (label, t0) => { if (DEBUG) console.log(`[timing] ${label}: ${(performance.now() - t0).toFixed(0)} ms`); };

// ---------------------------------------------------------------- small UI helpers
const hhmmss = () => new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
// progress messages that only differ in numbers/times update their own line
const logKey = (t) => t.split(" (")[0].replace(/[\d:.,()]+/g, "").replace(/\s+/g, " ").trim();
function logLine(el, text, bad) {
  const last = el.lastElementChild;
  if (last && !last.classList.contains("head") && last.dataset.key === logKey(text)) {
    last.querySelector(".m").textContent = text; last.classList.toggle("bad", bad); return;
  }
  const li = document.createElement("li");
  li.dataset.key = logKey(text); li.classList.toggle("bad", bad);
  li.innerHTML = `<time>${hhmmss()}</time><span class="m"></span>`;
  li.querySelector(".m").textContent = text;
  el.append(li);
  el.scrollTop = el.scrollHeight;
}
function logHead(id, text) {
  const el = $(id), li = document.createElement("li");
  li.className = "head"; li.innerHTML = `<time>${hhmmss()}</time><span class="m"></span>`;
  li.querySelector(".m").textContent = text; el.append(li); el.hidden = false;
}
function status(id, text, bad = false) {
  const el = $(id);
  if (el.classList.contains("log")) { el.hidden = false; logLine(el, text, bad); }
  else { el.textContent = text; el.classList.toggle("bad", bad); }
  if (S.busy && (id === S.where || id === "autoStatus")) $("activityText").textContent = `${S.busy}: ${text}`;
}
const setBar = (id, frac) => { $(id).style.transform = `scaleX(${Math.max(0, Math.min(1, frac)).toFixed(3)})`; };
/** Step status word: text is the English key (it picks the hint), shown translated. */
function pill(id, text, kind = "", vars) {
  const el = $(id); el.textContent = t(text, vars); el.className = `pill ${kind}`;
  const hint = pillHint(id, text);
  el.dataset.hint = hint; el.tabIndex = hint ? 0 : -1;
  const np = document.querySelector(`nav.steps .np[data-for="${id}"]`);
  if (np) { np.textContent = el.textContent; np.className = `np ${kind}`; np.dataset.hint = hint; }
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
  if (S.busy) { status(where, t("Wait for “{task}” to finish first.", { task: S.busy }), true); return false; }
  S.busy = t(name); S.where = where; S.stop = false; $("bgNote").hidden = false; lockActions(true);
  $("activityText").textContent = `${S.busy}…`; $("activity").hidden = false;
  return true;
}
function idle() { S.busy = null; $("bgNote").hidden = true; $("activity").hidden = true; title(""); lockActions(false); renderModel(); }

// ---------------------------------------------------------------- wizard navigation
const STEPS = ["start", "setup", "collect", "labels", "train", "install"];
const STEP_NAMES = { start: t("Start"), setup: t("Device"), collect: t("Collect"), labels: t("Labels"), train: t("Train"), install: t("Install") };
const STEP_PILL = { setup: "setupPill", collect: "collectPill", labels: "labelsPill", train: "trainPill", install: "installPill" };
let currentStep = "start";
function show(step) {
  if (!STEPS.includes(step)) step = "start";
  currentStep = step;
  document.querySelectorAll("section[data-step]").forEach((sec) => { sec.hidden = sec.dataset.step !== step; });
  document.querySelectorAll("nav.steps button").forEach((b) => b.removeAttribute("aria-current"));
  document.querySelector(`nav.steps button[data-step="${step}"]`)?.setAttribute("aria-current", "step");
  if (step !== "labels") $("drawer").hidden = true;
  if (location.hash !== `#${step}`) history.replaceState(null, "", `#${step}`);
  // keep the step rail where it is: if it is pinned to the top, open the new step right
  // under it; otherwise don't scroll at all (jumping to the top made the page lurch)
  const header = document.querySelector("header");
  const railTop = header.getBoundingClientRect().bottom + scrollY + parseFloat(getComputedStyle($("steps").parentElement).rowGap || "0");
  if (scrollY > railTop) window.scrollTo({ top: railTop, behavior: "instant" });
}
document.querySelectorAll("nav.steps button").forEach((b) => b.addEventListener("click", () => show(b.dataset.step)));
const setNavH = () => document.documentElement.style.setProperty("--navh", `${$("steps").offsetHeight}px`);
addEventListener("resize", setNavH); setNavH();
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
    next.textContent = t("Next: {step} →", { step: STEP_NAMES[STEPS[i + 1]] });
    next.addEventListener("click", () => show(STEPS[i + 1]));
    nav.append(next);
  }
  sec.append(nav);
});
function renderSummary() {
  const el = $("summary"); if (!el) return;
  el.innerHTML = STEPS.slice(1).map((st, i) =>
    `<button type="button" data-go="${st}">${i + 1} · ${STEP_NAMES[st]}<span data-hint="${esc($(STEP_PILL[st])?.dataset.hint || "")}">${esc($(STEP_PILL[st])?.textContent || "–")}</span></button>`).join("");
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
    $("checks").innerHTML = `<li class="lv-warn"><span class="dot"></span><span class="t">${esc(t("This page is not served by an AI-on-the-edge device"))}</span>
      <span class="d">${esc(t("Upload trainer.html.gz to /html/ on the device and open http://<device>/trainer.html to collect images and install models. Importing a dataset zip and training work here too."))}</span></li>`;
    return;
  }
  try {
    S.cfg = await dev.readConfig();
  } catch (e) { status("setupStatus", t("Could not read the configuration: {err}", { err: e.message }), true); return; }
  S.checks = configChecks(S.cfg);
  const worst = S.checks.some((c) => c.level === "block") ? "block" : S.checks.some((c) => c.level === "warn") ? "warn" : "ok";
  pill("setupPill", { block: "action needed", warn: "check", ok: "ready" }[worst], { block: "bad", warn: "warn", ok: "ok" }[worst]);
  $("checks").innerHTML = S.checks.map((c, i) => `<li class="lv-${c.level}"><span class="dot"></span><span class="t">${esc(c.title)}</span>
    ${c.fix ? `<button class="primary act" data-fix="${i}">${esc(c.fix.label)}</button>` : "<span></span>"}
    <span class="d">${esc(c.detail || "")}</span>
    ${c.fix ? `<span class="confirm d" data-confirm="${i}" hidden>${esc(t("This changes the configuration and restarts the device once."))}
      <button class="primary act" data-yes="${i}">${esc(t("Change and restart"))}</button><button data-no="${i}">${esc(t("Cancel"))}</button></span>` : ""}</li>`).join("");
}
$("checks").addEventListener("click", async (e) => {
  const b = e.target.closest("button"); if (!b) return;
  const i = b.dataset.fix ?? b.dataset.yes ?? b.dataset.no;
  const box = $("checks").querySelector(`[data-confirm="${i}"]`);
  if (b.dataset.fix) { box.hidden = false; return; }
  if (b.dataset.no) { box.hidden = true; return; }
  if (!busy("device setup", "setupStatus")) return;
  try {
    logHead("setupStatus", S.checks[i].fix.label);
    const next = S.checks[i].fix.apply(S.cfg);
    const backup = await dev.writeConfigAndReboot(next, (s) => status("setupStatus", s));
    await dev.waitForReading((s) => status("setupStatus", s));
    status("setupStatus", t("Done. The previous configuration is saved as {file}.", { file: backup }));
  } catch (err) {
    status("setupStatus", t("The change did not complete: {err}", { err: err.message }), true);
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
  $("revRoi").innerHTML = `<option value="">${esc(t("All"))}</option>` + rois.map((r) => `<option ${r === sel ? "selected" : ""}>${esc(r)}</option>`).join("");
  pill("collectPill", S.crops.length ? "{n} images" : "empty", S.crops.length ? "ok" : "", { n: S.crops.length.toLocaleString() });
  renderReview(true);
  const est = await store.usage();
  if (est && !S.busy) status("collectStatus", t("{n} images stored in this browser", { n: S.crops.length.toLocaleString() }) +
    (est.usage ? t(" ({mb} MB used)", { mb: (est.usage / 1e6).toFixed(0) }) : ""));
}

/** Recount after labels changed (debounced: keyboard labelling can be fast). */
let covTimer = 0;
function scheduleCoverage() {
  clearTimeout(covTimer);
  covTimer = setTimeout(() => { S.cov = coverage(S.crops, S.eff); renderCoverage(); }, 250);
}
/** Table heading with a hint (focusable, so it also works by keyboard and on touch). */
const th = (text, hint) => `<th data-hint="${esc(hint)}" tabindex="0">${esc(t(text))}</th>`;
function renderCoverage() {
  if (pop.cell) hidePop(); // its cell is about to be replaced
  const c = S.cov;
  if (!c.rois.length) { $("coverage").innerHTML = `<p class="hint">${esc(t("No images yet. Collect them in step 2."))}</p>`; status("verdict", ""); pill("labelsPill", "–"); return; }
  const head = `<tr>${th("Wheel", HINT.wheel)}${th("Images", HINT.images)}${th("Days", HINT.days)}${th("Usable", HINT.usable)}${th("To review", HINT.toReview)}${LABELS.map((l) => th(l, HINT.digit(l))).join("")}</tr>`;
  const cell = (roi, l, n, cls = "") => (n ? `<td class="cov ${cls}" tabindex="0" data-roi="${esc(roi)}" data-l="${esc(l)}">${n}</td>` : `<td class="${cls}">${n}</td>`);
  const body = c.rois.map((g) => `<tr><td>${esc(g.roi)}${g.rolling ? " ↻" : ""}</td><td>${g.crops}</td><td>${g.days}</td>${cell(g.roi, "*usable", g.usable)}${cell(g.roi, "*review", g.review)}${
    LABELS.map((l, i) => { const n = g.labels[l]; const need = i < 10 || g.rolling; return cell(g.roi, l, n, !need ? "" : n === 0 ? "lo" : n < 15 ? "mid" : ""); }).join("")}</tr>`).join("");
  $("coverage").innerHTML = `<table><thead>${head}</thead><tbody>${body}</tbody></table>
    <p class="hint">${esc(t("Usable images per label (your labels and confirmed ones). Point at a number to see examples; click it to review exactly those images. ↻ = a rolling wheel that often stops between two digits, so its in-between positions are needed too."))}</p>`;
  if (c.verdict === "ready") { pill("labelsPill", "ready to train", "ok"); status("verdict", t("Enough data: every digit has at least {min} usable images over {days} days.", { min: MIN_PER_DIGIT, days: c.days })); }
  else if (c.verdict === "not-enough") {
    pill("labelsPill", "not enough yet", "warn");
    status("verdict", t("Not enough yet") + (c.days < 2 ? t(" (only {n} day of images)", { n: c.days }) : "") + ". " +
      t("Missing: {list}", { list: c.missing.slice(0, 8).join(", ") }) + (c.missing.length > 8 ? t(" and {n} more", { n: c.missing.length - 8 }) : "") + ". " +
      t("Collect more days, or label images in the review below. You can still train, with weaker results."));
  }
}

// ---------------------------------------------------------------- coverage popover
const POP_N = 12;
let pop = { cell: null, urls: [], timer: 0 };
function spreadPick(list, n) {
  if (list.length <= n) return list;
  const out = [], step = list.length / n;
  for (let i = 0; i < n; i++) out.push(list[Math.floor(i * step + step / 2)]);
  return out;
}
function hidePop() {
  clearTimeout(pop.timer); pop.cell = null; $("covPop").hidden = true;
  pop.urls.forEach((u) => URL.revokeObjectURL(u)); pop.urls = [];
}
async function showPop(cell) {
  if (pop.cell === cell) return;
  hidePop(); pop.cell = cell;
  const { roi, l } = cell.dataset;
  const list = cellCrops(roi, l).sort((a, b) => (a.ts < b.ts ? -1 : 1));
  const pick = spreadPick(list, POP_N);
  const what = l === "*usable" ? t("usable") : l === "*review" ? t("to review") : t("labelled {l}", { l });
  const el = $("covPop");
  el.innerHTML = `<div class="ph">${esc(roi)} · ${esc(what)} · ${esc(t(list.length === 1 ? "{n} image" : "{n} images", { n: list.length }))}${list.length > POP_N ? esc(t(", {n} shown", { n: POP_N })) : ""}</div><div class="pg"></div><div class="pf">${esc(t("Click the number to review them."))}</div>`;
  const grid = el.querySelector(".pg");
  for (const c of pick) {
    const fig = document.createElement("figure");
    const img = document.createElement("img"); img.alt = "";
    const cap = document.createElement("figcaption");
    const e = S.eff.get(c.id);
    const when = `${c.ts.slice(6, 8)}.${c.ts.slice(4, 6)}`, at = `${c.ts.slice(9, 11)}:${c.ts.slice(11, 13)}`;
    cap.innerHTML = l.startsWith("*") ? `<b>${esc(e.label ?? "?")}</b>${when} ${at}` : `${when}<br>${at}`;
    fig.append(img, cap); grid.append(fig);
    store.getJpeg(c.id).then((b) => {
      if (!b || pop.cell !== cell) return;
      const u = URL.createObjectURL(new Blob([b], { type: "image/jpeg" })); pop.urls.push(u); img.src = u;
    });
  }
  // place it under the table (or above it), lined up with the cell, so it never covers
  // the other numbers; the popover itself ignores the pointer (see .pop in the CSS)
  el.hidden = false;
  const r = cell.getBoundingClientRect(), t = cell.closest("table").getBoundingClientRect();
  const w = el.offsetWidth, h = el.offsetHeight;
  let y = t.bottom + 8;
  if (y + h > innerHeight - 8 && t.top - h - 8 > 8) y = t.top - h - 8;
  const x = Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2));
  el.style.left = `${x}px`; el.style.top = `${Math.max(8, Math.min(y, innerHeight - h - 8))}px`;
}
$("coverage").addEventListener("mouseover", (e) => {
  const cell = e.target.closest("td.cov"); if (!cell) return;
  clearTimeout(pop.timer); pop.timer = setTimeout(() => showPop(cell), 120);
});
$("coverage").addEventListener("mouseout", (e) => {
  const to = e.relatedTarget?.closest?.("td.cov");
  if (to === pop.cell) return;
  clearTimeout(pop.timer);
  pop.timer = setTimeout(to ? () => showPop(to) : hidePop, to ? 60 : 200);
});
$("coverage").addEventListener("focusin", (e) => { const cell = e.target.closest("td.cov"); if (cell) showPop(cell); });
$("coverage").addEventListener("focusout", () => hidePop());
// click (or Enter): review exactly these images
function openCell(cell) {
  const { roi, l } = cell.dataset;
  hidePop();
  $("revRoi").value = roi;
  $("revLabel").value = l.startsWith("*") ? "" : l;
  $("revStatus").value = l === "*review" ? "review" : "usable";
  renderReview(true);
  document.querySelector("#sLabels h3").scrollIntoView({ behavior: "smooth", block: "start" });
}
$("coverage").addEventListener("click", (e) => { const cell = e.target.closest("td.cov"); if (cell) openCell(cell); });
$("coverage").addEventListener("keydown", (e) => { const cell = e.target.closest("td.cov"); if (cell && e.key === "Enter") { e.preventDefault(); openCell(cell); } });
window.addEventListener("scroll", () => { if (pop.cell) hidePop(); }, { passive: true });

// ---------------------------------------------------------------- 2. collect
let plan = null;
const fmtTime = (sec) => (sec < 90 ? t("{n} s", { n: Math.max(1, Math.round(sec)) }) : sec < 5400 ? t("{n} min", { n: Math.round(sec / 60) }) : t("{n} h", { n: (sec / 3600).toFixed(1) }));
const FILES_PER_S = 3; // what an ESP32-CAM serves; the measured rate replaces it while downloading

function renderPlan(p) {
  const box = $("plan");
  if (!p) { box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = `<div><b>${p.toFetch.toLocaleString()}</b><span>${esc(t("new images to download"))}</span></div>
    <div><b>${esc(t("about {time}", { time: fmtTime(p.toFetch / FILES_PER_S) }))}</b><span>${esc(t("at about {n} images/s", { n: FILES_PER_S }))}</span></div>
    <div><b>${p.onDevice.toLocaleString()}</b><span>${esc(t("images in {n} new hour folders on the device", { n: p.listed }))}</span></div>
    <div><b>${p.skippedEnough.toLocaleString()}</b><span>${esc(t("skipped: enough images of that reading already"))}</span></div>
    <div><b>${p.have.toLocaleString()}</b><span>${esc(t("already here"))}${p.knownHours ? esc(t(", plus {n} hours collected earlier", { n: p.knownHours })) : ""}</span></div>
    <details class="pw"><summary>${esc(t("Per wheel"))}</summary><div class="tw">${perWheelTable(p)}</div></details>`;
  $("btnCollect").disabled = !p.toFetch;
  $("btnCollect").textContent = p.toFetch ? t("Download {n} images", { n: p.toFetch.toLocaleString() }) : t("Nothing new to download");
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
  return `<table><thead><tr>${th("Wheel", HINT.wheel)}${th("To download", HINT.toDownload)}${th("Skipped", HINT.skipped)}${th("Readings full", HINT.readingsFull)}${th("Readings still short", HINT.readingsShort)}</tr></thead><tbody>${rows}</tbody></table>`;
}
/** Crops already stored per download group (wheel + device reading). */
function haveByGroup() {
  const m = new Map();
  for (const c of S.crops) if (c.pred != null) { const g = groupOf(c.roi, c.pred, c.rejected); m.set(g, (m.get(g) || 0) + 1); }
  return m;
}
async function runScan() {
  if (!S.onDevice) { status("collectStatus", t("Collecting needs the page to be opened from the device."), true); return null; }
  status("collectStatus", t("Listing the device's image folders…"));
  plan = await scan({
    days: +$("days").value || 7, quota: +$("quota").value || 100, have: haveByGroup(), shouldStop: () => S.stop,
    onProgress: (p) => {
      status("collectStatus", t("Listing folder {i} of {n} ({folder})…", { i: p.listed + 1, n: p.total, folder: p.folder }));
      setBar("collectBar", p.listed / Math.max(1, p.total)); title(t("checking {i}/{n}", { i: p.listed, n: p.total }));
    },
  });
  setBar("collectBar", 0);
  renderPlan(plan);
  status("collectStatus", plan.complete ? t("Checked {n} new hour folders in {time}", { n: plan.listed, time: fmtTime(plan.listSeconds) }) +
    (plan.fromCache ? t(" ({n} remembered from an earlier check)", { n: plan.fromCache }) : "") + "." : t("Check stopped early; the numbers cover the folders listed so far."));
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
      status("collectStatus", t("{i} of {n} downloaded", { i: p.fetched.toLocaleString(), n: p.total.toLocaleString() }) + (p.failed ? t(", {n} failed", { n: p.failed }) : "") +
        " · " + t("{n} images/s", { n: p.rate.toFixed(1) }) + " · " + t("about {time} left", { time: fmtTime(left / Math.max(0.1, p.rate)) }));
      title(t("collecting {p}%", { p: Math.round(((p.fetched + p.failed) / Math.max(1, p.total)) * 100) }));
    },
  });
  status("collectStatus", t(S.stop ? "Stopped: {n} new images" : "Done: {n} new images", { n: res.fetched.toLocaleString() }) + (res.failed ? t(", {n} could not be read", { n: res.failed }) : "") + ".");
  plan = null; renderPlan(null); $("btnCollect").textContent = t("Download"); $("btnCollect").disabled = true;
  await refreshProject();
}
async function runCollect() { await runScan(); if (!S.stop) await runDownload(); }

$("btnScan").addEventListener("click", async () => {
  if (!busy("checking the device", "collectStatus")) return;
  $("btnCollectStop").disabled = false;
  try { await runScan(); } catch (e) { status("collectStatus", t("Checking failed: {err}", { err: e.message }), true); }
  finally { idle(); $("btnCollectStop").disabled = true; $("btnCollect").disabled = !plan?.toFetch; }
});
$("btnCollect").addEventListener("click", async () => {
  if (!busy("collect", "collectStatus")) return;
  $("btnCollectStop").disabled = false;
  try { await runDownload(); } catch (e) { status("collectStatus", t("Collecting failed: {err}", { err: e.message }), true); }
  finally { idle(); $("btnCollectStop").disabled = true; $("btnCollect").disabled = !plan?.toFetch; }
});
$("btnCollectStop").addEventListener("click", () => { S.stop = true; });

$("btnImport").addEventListener("click", () => $("fileZip").click());
$("fileZip").addEventListener("change", async (e) => {
  const f = e.target.files[0]; if (!f || !busy("import", "collectStatus")) return;
  try {
    status("collectStatus", t("Reading {file}…", { file: f.name }));
    const buf = new Uint8Array(await f.arrayBuffer());
    const files = await new Promise((res, rej) => unzip(buf, (err, out) => (err ? rej(err) : res(out))));
    if (!files["labels.csv"]) throw new Error(t("labels.csv is missing from the zip"));
    // plain datasets: every label counts as yours; exports from this page carry the sources
    const rows = parseCsv(new TextDecoder().decode(files["labels.csv"])).filter((r) => r.label || r.human || r.llm || r.device);
    const rich = rows.length && "status" in rows[0];
    let batch = [], labels = [], n = 0;
    for (const r of rows) {
      const bytes = files[r.path]; if (!bytes) continue;
      try {
        const im = await decodeBrowser(bytes);
        const id = `zip/${f.name}/${r.path}`;
        const roi = r.roi || (r.src ? `${r.src}.dig${r.pos}` : `dig${r.pos}`);
        const pred = rich && r.device !== "" ? +r.device : null;
        batch.push({ crop: { id, roi, ts: r.ts || "00000000-000000", pred, rejected: rich && r.rejected === "1", w: im.width, h: im.height,
          pix: resizeBilinear(im.data, im.width, im.height, IN_W, IN_H, 4) }, jpeg: bytes });
        const rec = { id };
        if (!rich) rec.human = r.label;
        else { if (r.human) rec.human = r.human; if (r.llm) { rec.llm = r.llm; rec.llmModel = r.llm_model || "import"; } }
        labels.push(rec);
      } catch { /* skip unreadable */ }
      if (batch.length >= 200) { await store.putCrops(batch); await store.putLabels(labels); n += batch.length; batch = []; labels = []; status("collectStatus", t("Imported {i} of {n}…", { i: n, n: rows.length })); }
    }
    if (batch.length) { await store.putCrops(batch); await store.putLabels(labels); n += batch.length; }
    status("collectStatus", t("Imported {n} labelled images from {file}.", { n, file: f.name }));
    await refreshProject();
  } catch (err) { status("collectStatus", t("Import failed: {err}", { err: err.message || err }), true); }
  finally { idle(); e.target.value = ""; }
});

// ---- export: the same zip format the import reads, plus every label source
const csvCell = (v) => { const t = v == null ? "" : String(v); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
function exportRows(withImages) {
  return S.crops.map((c, i) => {
    const e = S.eff.get(c.id) || {}, r = S.labels.get(c.id) || {};
    const name = `images/${String(i).padStart(6, "0")}.jpg`;
    return { c, row: {
      path: withImages ? name : c.id, src: S.onDevice ? location.host : "", roi: c.roi, pos: c.roi.replace(/^.*?(\d+)$/, "$1"),
      label: e.label ?? "", status: e.status ?? "", sources: e.sources ?? "", ts: c.ts, split: "",
      device: c.pred ?? "", rejected: c.rejected ? 1 : 0, llm: r.llm ?? "", llm_model: r.llmModel ?? "", human: r.human ?? "", orig_id: c.id } };
  });
}
const COLS = ["path", "src", "roi", "pos", "label", "status", "sources", "ts", "split", "device", "rejected", "llm", "llm_model", "human", "orig_id"];
const toCsv = (rows) => [COLS.join(","), ...rows.map(({ row }) => COLS.map((k) => csvCell(row[k])).join(","))].join("\n") + "\n";
function saveFile(name, data, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([data], { type }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
const exportName = (ext) => `meter-labels_${(S.onDevice ? location.host : "local").replace(/[^\w.-]/g, "_")}_${stamp()}.${ext}`;
function exportCsv(where) {
  if (!S.crops.length) { status(where, t("Nothing to export yet."), true); return; }
  saveFile(exportName("csv"), toCsv(exportRows(false)), "text/csv");
  status(where, t("Exported the labels of {n} images (CSV).", { n: S.crops.length.toLocaleString() }));
}
async function exportZip(where) {
  if (!S.crops.length) { status(where, t("Nothing to export yet."), true); return; }
  if (!busy("export", where)) return;
  try {
    const rows = exportRows(true);
    const files = { "labels.csv": new TextEncoder().encode(toCsv(rows)) };
    let n = 0;
    for (const { c, row } of rows) {
      const b = await store.getJpeg(c.id);
      if (b) files[row.path] = [b, { level: 0 }]; // JPEGs don't compress further
      if (++n % 500 === 0) status(where, t("Packing {i} of {n} images…", { i: n.toLocaleString(), n: rows.length.toLocaleString() }));
    }
    const out = await new Promise((res, rej) => zip(files, (err, data) => (err ? rej(err) : res(data))));
    saveFile(exportName("zip"), out, "application/zip");
    status(where, t("Exported {n} images with their labels ({mb} MB). Import it here or on another computer with “Import a labelled dataset zip”.", { n: rows.length.toLocaleString(), mb: (out.length / 1e6).toFixed(1) }));
  } catch (e) { status(where, t("Export failed: {err}", { err: e.message }), true); }
  finally { idle(); }
}
$("btnExportCsv").addEventListener("click", () => exportCsv("collectStatus"));
$("btnExportZip").addEventListener("click", () => exportZip("collectStatus"));
$("btnExportCsv2").addEventListener("click", () => exportCsv("revStatusLine"));
$("btnExportZip2").addEventListener("click", () => exportZip("revStatusLine"));

$("btnClear").addEventListener("click", () => { $("clearConfirm").hidden = false; });
$("btnClearNo").addEventListener("click", () => { $("clearConfirm").hidden = true; });
$("btnClearYes").addEventListener("click", async () => {
  $("clearConfirm").hidden = true;
  await store.clearAll(); S.model = null; await refreshProject(); status("collectStatus", t("All data in this browser deleted."));
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

// Which images to ask the AI about. The budget is spread over wheels and readings: images
// are grouped like the collector does (wheel + device reading), groups with the fewest
// usable labels go first, and each round takes one image per group (random within the
// group, so different days and times of day). Disagreements come before unconfirmed
// images within a group; already confirmed ones only when budget is left.
const AI_TARGET = MIN_PER_DIGIT; // usable labels per group before the AI moves on
function llmQueue(limit) {
  const s = llmSettings();
  const rank = { conflict: 0, unconfirmed: 1, confirmed: 2 };
  const key = (c) => (c.pred != null ? groupOf(c.roi, c.pred, c.rejected) : `${c.roi}|${S.eff.get(c.id)?.label ?? "?"}`);
  const usable = new Map(), groups = new Map();
  for (const c of S.crops) {
    const e = S.eff.get(c.id); if (!e) continue;
    const k = key(c);
    if (e.status === "human" || e.status === "confirmed") usable.set(k, (usable.get(k) || 0) + 1);
    const r = S.labels.get(c.id);
    if (r?.human || (r?.llm && r.llmModel === s.model) || !(e.status in rank)) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  }
  for (const list of groups.values()) {
    for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; }
    list.sort((a, b) => rank[S.eff.get(a.id).status] - rank[S.eff.get(b.id).status]); // stable: random within a status
  }
  const order = [...groups.keys()].sort((a, b) => (usable.get(a) || 0) - (usable.get(b) || 0));
  const out = [], taken = new Map();
  for (const pass of ["needed", "rest"]) {
    let added = true;
    while (out.length < limit && added) {
      added = false;
      for (const k of order) {
        if (out.length >= limit) break;
        const list = groups.get(k), n = taken.get(k) || 0;
        if (n >= list.length) continue;
        if (pass === "needed" && ((usable.get(k) || 0) + n >= AI_TARGET || rank[S.eff.get(list[n].id).status] === 2)) continue;
        out.push(list[n]); taken.set(k, n + 1); added = true;
      }
    }
  }
  out.groups = taken.size;
  out.wheels = new Set(out.map((c) => c.roi)).size;
  return out;
}
$("btnLlmTest").addEventListener("click", async () => {
  const c = llmQueue(1)[0] || S.crops[0];
  if (!c) { status("llmStatus", t("Collect images first."), true); return; }
  status("llmStatus", t("Asking…"));
  try {
    const r = await llm.ask(llmSettings(), await llm.encodeCrop(await store.getJpeg(c.id)));
    status("llmStatus", t("Works: answered “{a}” for a {roi} image in {s} s (device read {d}).", { a: r.answer, roi: c.roi, s: r.seconds.toFixed(1), d: c.pred ?? "–" }));
  } catch (e) { status("llmStatus", e.message, true); }
});
async function runLlm(limit) {
  const s = llmSettings();
  await store.kvSet("llm", s);
  const q = llmQueue(limit);
  if (!q.length) { status("llmStatus", t("Nothing left to ask about.")); return; }
  status("llmStatus", t("Asking about {n} images from {w} wheels and {g} different readings…", { n: q.length, w: q.wheels, g: q.groups }));
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
      scheduleCoverage();
      done++;
    } catch (e) {
      failed++;
      if (failed >= 3 && done === 0) throw e;
    }
    const per = (performance.now() - t0) / 1000 / (done + failed);
    status("llmStatus", t("{i} of {n} labelled", { i: done, n: q.length }) + (failed ? t(", {n} failed", { n: failed }) : "") +
      t(", {s} s each, about {m} min left", { s: per.toFixed(1), m: Math.ceil(((q.length - done - failed) * per) / 60) }));
    title(t("AI labels {i}/{n}", { i: done, n: q.length }));
  }
  status("llmStatus", t(S.stop ? "Stopped: {n} images from {w} wheels and {g} readings labelled by {model}" : "Done: {n} images from {w} wheels and {g} readings labelled by {model}",
    { n: done, w: q.wheels, g: q.groups, model: s.model }) + (failed ? t(", {n} failed", { n: failed }) : "") + ".");
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
const usableSt = (st) => st === "human" || st === "confirmed";
const reviewSt = (st) => st === "unconfirmed" || st === "conflict";
/** Crops behind one coverage cell: label "*usable", "*review" or a label like "7/8". */
function cellCrops(roi, l) {
  return S.crops.filter((c) => {
    if (c.roi !== roi) return false;
    const e = S.eff.get(c.id);
    if (l === "*usable") return usableSt(e.status);
    if (l === "*review") return reviewSt(e.status);
    return usableSt(e.status) && e.label === l;
  });
}
function reviewList(useFilters = true) {
  const st = $("revStatus").value;
  const roi = useFilters ? $("revRoi").value : "", lab = useFilters ? $("revLabel").value : "";
  return S.crops.filter((c) => {
    if (roi && c.roi !== roi) return false;
    const e = S.eff.get(c.id);
    if (lab && e.label !== lab) return false;
    if (st === "usable") return usableSt(e.status);
    if (st === "unapproved") return e.status !== "human" && e.status !== "excluded" && !!e.label;
    if (st === "review") return e.status === "unconfirmed" || e.status === "conflict";
    if (st === "conflict") return e.status === "conflict";
    if (st === "human") return e.status === "human" || e.status === "excluded";
    return true;
  }).sort((a, b) => S.eff.get(a.id).score - S.eff.get(b.id).score || (a.ts < b.ts ? 1 : -1));
}
// ---- guided review: one wheel + label group at a time, empty groups skipped
const labelOrder = (l) => { const i = LABELS.indexOf(l); return i < 0 ? 99 : i; };
const groupKeyOf = (c) => `${c.roi}|${S.eff.get(c.id)?.label ?? "?"}`;
function reviewGroups() {
  const m = new Map();
  for (const c of reviewList(false)) { const k = groupKeyOf(c); if (!m.has(k)) m.set(k, []); m.get(k).push(c); }
  const keys = [...m.keys()].sort((a, b) => {
    const [ra, la] = a.split("|"), [rb, lb] = b.split("|");
    return ra.localeCompare(rb, undefined, { numeric: true }) || labelOrder(la) - labelOrder(lb);
  });
  return { keys, m };
}
const stillOpen = (c) => {
  const st = $("revStatus").value, e = S.eff.get(c.id);
  if (st === "review") return e.status === "unconfirmed" || e.status === "conflict";
  if (st === "conflict") return e.status === "conflict";
  return !S.labels.get(c.id)?.human;
};
function setGroup(key) {
  rev.groupKey = key;
  const [roi, lab] = key ? key.split("|") : ["", ""];
  $("revRoi").value = roi; $("revLabel").value = lab === "?" ? "" : lab;
}
/** Move to the group dir (+1 / -1) steps from the current one, among groups with images. */
function gotoGroup(dir) {
  const { keys } = reviewGroups();
  if (!keys.length) { setGroup(null); renderReview(true); return; }
  const cmp = (a, b) => {
    const [ra, la] = a.split("|"), [rb, lb] = b.split("|");
    return ra.localeCompare(rb, undefined, { numeric: true }) || labelOrder(la) - labelOrder(lb);
  };
  let next;
  if (!rev.groupKey) next = keys[0];
  else if (dir > 0) next = keys.find((k) => cmp(k, rev.groupKey) > 0) ?? keys[0];
  else next = [...keys].reverse().find((k) => cmp(k, rev.groupKey) < 0) ?? keys[keys.length - 1];
  setGroup(next); renderReview(true);
}
function renderGroupBar() {
  const bar = $("revGroupBar");
  if (!$("revGuided").checked) { bar.hidden = true; return; }
  bar.hidden = false;
  const { keys } = reviewGroups();
  const left = rev.list.filter(stillOpen).length;
  const [roi, lab] = (rev.groupKey || "|").split("|");
  const pos = rev.groupKey ? keys.indexOf(rev.groupKey) : -1;
  $("revGroupText").innerHTML = rev.groupKey
    ? `<b>${esc(roi)}</b> · ${esc(t("shown as"))} <b>${esc(lab)}</b> · ${esc(t("{i} of {n} still to check", { i: left, n: rev.list.length }))} · ${esc(t("group {i} of {n}", { i: pos >= 0 ? pos + 1 : "–", n: keys.length }))}${pos < 0 ? esc(t(" (done)")) : ""}`
    : keys.length ? "" : esc(t("Nothing left to review here."));
  $("revAccept").textContent = lab && lab !== "?" ? t("Approve all as {l} ({n})", { l: lab, n: left }) : t("Approve all");
  $("revAccept").disabled = !left || lab === "?" || !lab;
  $("revPrev").disabled = $("revNext").disabled = !keys.length;
}
async function acceptRest() {
  const todo = rev.list.filter((c) => stillOpen(c) && S.eff.get(c.id)?.label);
  if (!todo.length) return;
  const recs = todo.map((c) => ({ ...(S.labels.get(c.id) || { id: c.id }), human: S.eff.get(c.id).label }));
  await store.putLabels(recs);
  recs.forEach((r, i) => { S.labels.set(r.id, r); S.eff.set(r.id, effective(todo[i], r, S.steady)); });
  scheduleCoverage();
  { const [roi, lab] = rev.groupKey.split("|"); status("revStatusLine", t("Approved {n} images of {roi} as {l}.", { n: todo.length, roi, l: lab })); }
  gotoGroup(+1);
}

function renderReview(reset) {
  if (reset) {
    if ($("revGuided").checked) {
      const { keys, m } = reviewGroups();
      if (!rev.groupKey || !m.has(rev.groupKey)) setGroup(keys.find((k) => !rev.groupKey || k > rev.groupKey) ?? keys[0] ?? null);
      rev.list = rev.groupKey ? m.get(rev.groupKey) : [];
      rev.list.sort((a, b) => (a.ts < b.ts ? -1 : 1));
    } else rev.list = reviewList();
    rev.shown = $("revGuided").checked ? rev.list.length : REV_PAGE; rev.sel = -1; $("drawer").hidden = true;
  }
  renderGroupBar();
  rev.urls.forEach((u) => URL.revokeObjectURL(u)); rev.urls = [];
  const g = $("revGrid"); g.textContent = "";
  rev.list.slice(0, rev.shown).forEach((c, k) => g.append(tile(c, k)));
  $("revMore").hidden = rev.shown >= rev.list.length;
  $("revMore").textContent = t("Show more ({n} left)", { n: rev.list.length - rev.shown });
  if (!rev.list.length) g.innerHTML = `<p class="hint">${esc(t("Nothing to show here."))}</p>`;
}
const tileImages = new IntersectionObserver((entries) => {
  for (const en of entries) {
    if (!en.isIntersecting) continue;
    const img = en.target;
    tileImages.unobserve(img);
    store.getJpeg(img.dataset.id).then((b) => {
      if (!b || !img.isConnected) return;
      const u = URL.createObjectURL(new Blob([b], { type: "image/jpeg" })); rev.urls.push(u); img.src = u;
    });
  }
}, { rootMargin: "400px 0px" });
function tile(c, k) {
  const e = S.eff.get(c.id);
  const t = document.createElement("button");
  t.type = "button"; t.className = `tile st-${e.status}`; t.dataset.k = k; t.dataset.hint = statusHint[e.status] || "";
  t.setAttribute("aria-selected", k === rev.sel ? "true" : "false");
  const img = document.createElement("img"); img.alt = ""; img.loading = "lazy";
  img.dataset.id = c.id;
  tileImages.observe(img);
  const l = document.createElement("span"); l.className = "l"; l.textContent = e.status === "excluded" ? "x" : (e.label ?? "?");
  const s = document.createElement("span"); s.className = "s"; s.textContent = `${c.roi} · ${sourcesText(e.sources)}`;
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
  status("selInfo", t("{roi}  {ts}  label {l} ({src})  device {d}{rej}  AI {ai}", { roi: c.roi, ts: c.ts, l: e.status === "excluded" ? "x" : e.label ?? "?",
    src: sourcesText(e.sources), d: c.pred ?? "–", rej: c.rejected ? t(" rejected") : "", ai: r.llm ?? "–" }));
  const keys = $("keys"); keys.textContent = "";
  [...LABELS, "x"].forEach((l, i) => {
    if (i === 10 || i === 20) { const sp = document.createElement("span"); sp.className = "sep"; keys.append(sp); }
    const bt = document.createElement("button"); bt.type = "button"; bt.textContent = l === "x" ? t("X unusable") : l;
    if ((r.human || (e.status !== "excluded" && e.label)) === l || (l === "x" && e.status === "excluded")) bt.classList.add("on");
    bt.addEventListener("click", () => setHuman(c, l));
    keys.append(bt);
  });
  const rm = document.createElement("button"); rm.type = "button"; rm.textContent = t("Remove my label"); rm.disabled = !r.human;
  rm.addEventListener("click", () => setHuman(c, null)); keys.append(rm);
}
async function setHuman(c, l) {
  await store.setLabel(c.id, { human: l });
  const rec = { ...(S.labels.get(c.id) || { id: c.id }) };
  if (l === null) delete rec.human; else rec.human = l;
  S.labels.set(c.id, rec);
  S.eff.set(c.id, effective(c, rec, S.steady));
  scheduleCoverage();
  const old = $("revGrid").querySelector(`[data-k="${rev.sel}"]`);
  if (old) old.replaceWith(tile(c, rev.sel));
  drawer();
  if ($("revGuided").checked) {
    renderGroupBar();
    if (l !== null && !rev.list.some(stillOpen)) {
      status("revStatusLine", t("{group} done.", { group: rev.groupKey.replace("|", " · ") }));
      setTimeout(() => gotoGroup(+1), 500);
    }
  }
}
function filterChanged() {
  if ($("revGuided").checked) {
    const roi = $("revRoi").value, lab = $("revLabel").value;
    const { keys } = reviewGroups();
    setGroup(keys.find((k) => { const [r, l] = k.split("|"); return (!roi || r === roi) && (!lab || l === lab); }) ?? null);
  }
  renderReview(true);
}
$("revRoi").addEventListener("change", filterChanged);
$("revLabel").addEventListener("change", filterChanged);
$("revStatus").addEventListener("change", () => { rev.groupKey = null; renderReview(true); });
$("revGuided").addEventListener("change", () => { rev.groupKey = null; if (!$("revGuided").checked) { $("revRoi").value = ""; $("revLabel").value = ""; } renderReview(true); });
$("revPrev").addEventListener("click", () => gotoGroup(-1));
$("revNext").addEventListener("click", () => gotoGroup(+1));
$("revAccept").addEventListener("click", acceptRest);
$("revMore").addEventListener("click", () => { rev.shown += REV_PAGE; renderReview(false); });
document.addEventListener("keydown", (e) => {
  if (/INPUT|SELECT|TEXTAREA/.test(e.target.tagName) || e.ctrlKey || e.metaKey || e.altKey) return;
  if (currentStep === "labels" && $("revGuided").checked) {
    if (e.key === "]" || e.key === "PageDown") { e.preventDefault(); gotoGroup(+1); return; }
    if (e.key === "[" || e.key === "PageUp") { e.preventDefault(); gotoGroup(-1); return; }
    if (e.key === "a" || e.key === "A") { e.preventDefault(); if (!$("revAccept").disabled) acceptRest(); return; }
  }
  if ($("drawer").hidden) return;
  const k = e.key, c = rev.list[rev.sel];
  const next = () => setTimeout(() => select(Math.min(rev.list.length - 1, rev.sel + 1)), 80);
  if (k === "ArrowRight" || k === "ArrowDown") { e.preventDefault(); select(Math.min(rev.list.length - 1, rev.sel + 1)); return; }
  if (k === "ArrowLeft" || k === "ArrowUp") { e.preventDefault(); select(Math.max(0, rev.sel - 1)); return; }
  if (!c) return;
  if (k === "Escape") { $("drawer").hidden = true; return; }
  if (k === "t" || k === "T") { rev.tPending = true; status("selInfo", t("Between two digits: press the lower one (T 6 = 6/7)")); return; }
  if (/^[0-9]$/.test(k)) { e.preventDefault(); const l = rev.tPending ? `${k}/${(+k + 1) % 10}` : k; rev.tPending = false; setHuman(c, l).then(next); return; }
  if (k === "x" || k === "X") { setHuman(c, "x").then(next); return; }
  if (k === "Enter") { const lab = S.eff.get(c.id).label; if (lab) setHuman(c, lab).then(next); return; }
  if (k === "Backspace") { e.preventDefault(); setHuman(c, null); }
});

// ---------------------------------------------------------------- 4. train
let trainCtx = { epochs: 1, history: [], phase: 0, phases: 1, label: "" };
function onTrainProgress(m) {
  const frac = (trainCtx.phase + (m.epoch + m.step / m.steps) / trainCtx.epochs) / trainCtx.phases;
  setBar("trainBar", frac); title(t("{p}% training", { p: Math.round(frac * 100) }));
}
function onEpoch(e) {
  trainCtx.history.push(e); drawChart();
  status("trainStatus", trainCtx.label + t("Epoch {i}/{n}  loss {l}  validation loss {vl}  validation accuracy {va}%  {s} s/epoch  about {m} min left", {
    i: e.epoch + 1, n: e.epochs, l: e.loss.toFixed(3), vl: e.valLoss.toFixed(3), va: (e.valAcc * 100).toFixed(1), s: e.seconds.toFixed(1),
    m: Math.ceil((((e.epochs - e.epoch - 1) + (trainCtx.phases - trainCtx.phase - 1) * e.epochs) * e.seconds) / 60) }));
}
function drawChart() {
  const c = $("chart"), h = trainCtx.history;
  const dpr = window.devicePixelRatio || 1, cssW = c.clientWidth || 900, cssH = c.clientHeight || 130;
  if (c.width !== Math.round(cssW * dpr)) { c.width = Math.round(cssW * dpr); c.height = Math.round(cssH * dpr); }
  const ctx = c.getContext("2d"), W = cssW, H = cssH;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const css = getComputedStyle(document.documentElement);
  const tok = (n) => css.getPropertyValue(n).trim();
  ctx.clearRect(0, 0, W, H);
  if (!h.length) return;
  const max = Math.max(...h.map((e) => Math.max(e.loss, e.valLoss)));
  const x = (i) => 34 + (i / Math.max(1, trainCtx.epochs - 1)) * (W - 44), y = (v) => H - 14 - (v / max) * (H - 28);
  ctx.strokeStyle = tok("--color-rule"); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(34, y(0) + 0.5); ctx.lineTo(W - 10, y(0) + 0.5); ctx.stroke();
  ctx.fillStyle = tok("--color-muted"); ctx.font = `11px ${tok("--font-mono")}`;
  ctx.fillText(max.toFixed(2), 2, 14); ctx.fillText("0", 2, H - 10);
  for (const [key, color] of [["loss", "--color-accent"], ["valLoss", "--color-warn"]]) {
    ctx.strokeStyle = tok(color); ctx.lineWidth = 2; ctx.lineJoin = "round"; ctx.beginPath();
    h.forEach((e, i) => (i ? ctx.lineTo(x(i), y(e[key])) : ctx.moveTo(x(i), y(e[key])))); ctx.stroke();
  }
}

/** Train one model in the worker on the given set; resolves with the worker's "trained" message. */
async function trainOnce(set, filters, dense, epochs) {
  worker.postMessage({ type: "data", X: set.X, Y: set.Y.slice() }, [set.X.buffer]);
  const done = once("trained");
  trainCtx.history = [];
  worker.postMessage({ type: "train", filters, dense, epochs, batch: +$("batch").value || 64, lr: +$("lr").value || 1e-3,
    trainIdx: set.trainIdx, valIdx: set.valIdx, testIdx: set.testIdx });
  return done;
}
async function runTrain() {
  const tb = performance.now();
  const includeUnconfirmed = $("useUnconfirmed").checked, final = $("finalAll").checked;
  const set = buildTrainSet(S.crops, S.eff, { includeUnconfirmed });
  tlog(`buildTrainSet train ${set.trainIdx.length} test ${set.testIdx.length}`, tb);
  if (set.trainIdx.length < 200) throw new Error(t("only {n} usable training images; collect or label more first", { n: set.trainIdx.length }));
  const [filters, dense] = parseSize($("size").value);
  const epochs = +$("epochs").value || 60;
  const t0 = performance.now();
  // 1. train without the test images, to compare with the installed model on them
  trainCtx = { epochs, history: [], phase: 0, phases: final ? 2 : 1, label: final ? t("Step 1 of 2 (for the comparison): ") : "" };
  status("trainStatus", trainCtx.label + t("training on {n} images, testing on {m} from each wheel’s newest days…", { n: set.trainIdx.length.toLocaleString(), m: set.testIdx.length.toLocaleString() }));
  const res = await trainOnce(set, filters, dense, epochs);
  S.set = set; S.compare = compareOnTest(set, res.probs);
  let calib = set.trainIdx.slice(0, 300), kept = res.bestEpoch, trainN = set.trainIdx.length;
  // 2. the model to install: the same recipe on every usable image, the test images included
  if (final && !S.stop) {
    const all = buildTrainSet(S.crops, S.eff, { includeUnconfirmed, all: true });
    trainCtx = { ...trainCtx, phase: 1, label: t("Step 2 of 2 (final model, all images): ") };
    status("trainStatus", trainCtx.label + t("training on {n} images…", { n: all.trainIdx.length.toLocaleString() }));
    const res2 = await trainOnce(all, filters, dense, epochs);
    calib = all.trainIdx.slice(0, 300); kept = res2.bestEpoch; trainN = all.trainIdx.length;
  }
  setBar("trainBar", 1);
  // export right away (calibration on 300 training images of the set the worker holds now)
  const name = `dig-browser-f${filters[0]}_${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}_q.tflite`;
  const ex = once("exported");
  worker.postMessage({ type: "export", name, calibIdx: calib });
  const { bytes } = await ex;
  const tot = S.compare.reduce((a, e) => ({ n: a.n + e.n, m: a.m + e.model, d: a.d + e.dev, dn: a.dn + e.devN, md: a.md + e.modelOnDev }),
    { n: 0, m: 0, d: 0, dn: 0, md: 0 });
  // compare with the installed model on the same images, and only with enough of them
  const fair = tot.dn >= MIN_COMPARE;
  S.model = { name, bytes, at: Date.now(), acc: tot.n ? tot.m / tot.n : null, compareN: tot.dn, final: final && !S.stop, trainN,
    accOnDev: fair ? tot.md / tot.dn : null, devAcc: fair ? tot.d / tot.dn : null };
  await store.kvSet("lastModel", S.model);
  status("trainStatus", t("Done in {m} min (kept epoch {e}). Model {kb} KB, trained on {n} images", { m: ((performance.now() - t0) / 60000).toFixed(1), e: kept + 1, kb: (bytes.length / 1024).toFixed(0), n: trainN.toLocaleString() }) +
    (S.model.final ? t(", the test images included") : "") + ".");
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
  $("evalTable").innerHTML = `<table><thead><tr>${th("Wheel", HINT.wheel)}${th("Test images", HINT.testImages)}${th("New model", HINT.newModel)}${th("Device now", HINT.deviceNow)}${th("Between digits", HINT.between)}${th("New model", HINT.newModelBetween)}</tr></thead><tbody>${rows}</tbody></table>
    <p class="hint">${esc(t("Test images are each wheel’s newest days and were not used for this comparison. “Device now” is what the installed model read on the same images."))}${
      m?.final ? " " + esc(t("The model to install was then trained again on all images, the test images included, so it has seen more than the one scored here.")) : ""} ${
      esc(m?.devAcc != null ? t("On the {n} test images the device read itself: new {a}%, installed {b}%. Where the label came from the device, the installed model’s score is flattered.", { n: m.compareN, a: (m.accOnDev * 100).toFixed(1), b: (m.devAcc * 100).toFixed(1) })
        : t("Only {n} test images were read by the device ({min} needed), so the two models are not compared; collect more days.", { n: m?.compareN ?? 0, min: MIN_COMPARE }))}</p>`;
  const v = verdictOf(m);
  pill("trainPill", m ? { better: "new model ready", worse: "not better", unknown: "not compared" }[v] : "–", m ? { better: "ok", worse: "warn", unknown: "" }[v] : "");
}
$("btnTrain").addEventListener("click", async () => {
  if (!busy("training", "trainStatus")) return;
  $("btnTrain").disabled = true; $("btnStop").disabled = false;
  try { await runTrain(); } catch (e) { status("trainStatus", t("Training failed: {err}", { err: e.message }), true); }
  finally { idle(); $("btnTrain").disabled = false; $("btnStop").disabled = true; }
});
$("btnStop").addEventListener("click", () => { S.stop = true; worker.postMessage({ type: "stop" }); });

// ---------------------------------------------------------------- 5. install
function renderModel() {
  const m = S.model;
  $("btnInstall").disabled = !m || !S.onDevice; $("btnDownload").disabled = !m;
  if (m) $("fname").value = m.name;
  pill("installPill", m ? "model of {date}" : "no model yet", "", { date: m ? new Date(m.at).toLocaleString() : "" });
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
  $("installConfirmText").textContent = t("Replace {cur} with {new}? The device restarts once.", { cur, new: $("fname").value.trim() || m.name }) + " " +
    (m.devAcc != null ? t("Test images: new {a}%, current {b}%.", { a: (m.accOnDev * 100).toFixed(1), b: (m.devAcc * 100).toFixed(1) }) : t("The models were not compared (too few test images from this device)."));
  $("installConfirm").hidden = false;
});
$("btnInstallNo").addEventListener("click", () => { $("installConfirm").hidden = true; });
$("btnInstallYes").addEventListener("click", async () => {
  $("installConfirm").hidden = true;
  if (!busy("install", "installStatus")) return;
  try { await runInstall(); } catch (e) { status("installStatus", t("Install did not complete: {err}", { err: e.message }), true); }
  finally { idle(); refreshSetup(); }
});

async function runInstall() {
  const m = S.model;
  const name = ($("fname").value.trim() || m.name).replace(/[^\w.-]/g, "_");
  const path = `/config/${name.endsWith(".tflite") ? name : `${name}.tflite`}`;
  logHead("installStatus", t("Install {file}", { file: path }));
  status("installStatus", t("Uploading the model ({kb} KB)…", { kb: (m.bytes.length / 1024).toFixed(0) }));
  await dev.upload(path, m.bytes);
  status("installStatus", t("Model uploaded and checked (MD5)."));
  const cfg = await dev.readConfig();
  const prev = getKey(cfg, "Digits", "Model")?.value;
  const backup = await dev.writeConfigAndReboot(setKey(cfg, "Digits", "Model", path), (s) => status("installStatus", s));
  const v = await dev.waitForReading((s) => status("installStatus", s));
  const first = Object.values(v)[0];
  const hist = await store.kvGet("installs", []);
  hist.push({ at: Date.now(), model: path, prev, backup });
  await store.kvSet("installs", hist);
  status("installStatus", t("Installed. First reading with {file}: {v} ({err}). Previous model: {prev}; configuration copy: {backup}.", { file: path, v: first?.value, err: first?.error, prev, backup }));
  pill("installPill", "installed", first?.error === "no error" ? "ok" : "warn");
  showUndo();
}
async function showUndo() {
  const last = (await store.kvGet("installs", [])).at(-1);
  $("btnUndo").hidden = !last || !S.onDevice;
  if (last) $("btnUndo").textContent = t("Go back to {file}", { file: last.prev.split("/").pop() });
}
$("btnUndo").addEventListener("click", async () => {
  if (!busy("undo", "installStatus")) return;
  try {
    const hist = await store.kvGet("installs", []);
    const last = hist.at(-1);
    logHead("installStatus", t("Go back to {file}", { file: last.prev }));
    const cfg = await dev.readConfig();
    await dev.writeConfigAndReboot(setKey(cfg, "Digits", "Model", last.prev), (s) => status("installStatus", s));
    const v = await dev.waitForReading((s) => status("installStatus", s));
    hist.pop(); await store.kvSet("installs", hist);
    status("installStatus", t("Back on {file}. Reading: {v}.", { file: last.prev, v: Object.values(v)[0]?.value }));
  } catch (e) { status("installStatus", t("Undo did not complete: {err}", { err: e.message }), true); }
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
      if (S.checks.some((c) => c.level === "block")) throw new Error(t("fix the device setup in step 1 first"));
      say(t("Step 2: collecting new images…")); await runCollect();
    }
    if (S.stop) throw new Error("stopped");
    if ($("autoLlm").checked) { say(t("Step 3: asking the AI server for labels…")); await runLlm(+$("autoLlmN").value || 200); }
    if (S.stop) throw new Error("stopped");
    if (S.cov.verdict === "blocked") throw new Error(t("no images to train on"));
    say(t(S.cov.verdict === "not-enough" ? "Step 4: training (with less data than recommended)…" : "Step 4: training…"));
    const m = await runTrain();
    if (S.stop) throw new Error("stopped");
    const v = verdictOf(m);
    if (v === "worse") { say(t("Finished. On the same test images the new model read {a}%, the installed one {b}%: not installed.", { a: (m.accOnDev * 100).toFixed(1), b: (m.devAcc * 100).toFixed(1) })); return; }
    if (v === "unknown") { say(t("Finished. Too few test images from this device to compare with the installed model ({n} of {min}), so it was not installed automatically. Install it in step 5 if you want.", { n: m.compareN, min: MIN_COMPARE })); return; }
    if (!$("autoInstall").checked || !S.onDevice) { say(t("Finished. The new model is ready to install in step 5.")); return; }
    say(t("Step 5: installing the new model…")); await runInstall();
    say(t("Finished: the new model is installed and reading."));
  } catch (e) { say(t("Automatic run stopped: {err}", { err: e.message === "stopped" ? t("stopped") : e.message }), e.message !== "stopped"); }
  finally { idle(); $("btnAuto").disabled = false; $("btnAutoStop").disabled = true; }
});
$("btnAutoStop").addEventListener("click", () => { S.stop = true; worker.postMessage({ type: "stop" }); });
window.addEventListener("beforeunload", (e) => { if (S.busy) { e.preventDefault(); e.returnValue = ""; } });

// ---------------------------------------------------------------- start
/** Hints for fixed parts of the page: settings fields and the chart legend. */
function staticHints() {
  const at = (sel, hint) => { const el = document.querySelector(sel); if (el) el.dataset.hint = hint; };
  at('label[for="days"]', HINT.daysBack); at('label[for="quota"]', HINT.perReading);
  at('label[for="size"]', HINT.modelSize); at('label[for="epochs"]', HINT.epochs);
  at('label[for="batch"]', HINT.batch); at('label[for="lr"]', HINT.lr);
  at('label[for="llmN"]', HINT.llmN); at('label:has(#finalAll)', HINT.finalAll); at('label[for="revStatus"]', HINT.show);
  const lg = document.querySelectorAll(".legend > span");
  if (lg[0]) { lg[0].dataset.hint = HINT.trainLoss; lg[0].tabIndex = 0; }
  if (lg[1]) { lg[1].dataset.hint = HINT.valLoss; lg[1].tabIndex = 0; }
}
const SIZE_NAMES = {
  "24,48,48|128,64": "Small · {m} M ops/digit",
  "32,64,64|128,64": "Medium · {m} M ops/digit",
  "64,128,64|256,64": "Large · {m} M ops/digit (slow on the device)",
};
/** Label sources as shown on tiles: "device + LLM", "device 3 vs LLM 5", ... */
function sourcesText(src) {
  const m = /^device (\S+) vs LLM (\S+)$/.exec(src || "");
  return m ? t("device {a} vs AI {b}", { a: m[1], b: m[2] }) : t(src || "");
}
/** Small switch in the header: shows the other language's name, reloads in it. */
function langSwitch() {
  const other = LANG === "ru" ? "en" : "ru";
  const b = document.createElement("button");
  b.type = "button"; b.className = "link lang"; b.lang = other; b.textContent = LANGS[other];
  b.addEventListener("click", () => { if (!S.busy || confirm(t("Switching the language reloads the page and stops “{task}”. Continue?", { task: S.busy }))) setLang(other); });
  document.querySelector("header .badges").append(b);
}
async function init() {
  initHints(); staticHints(); langSwitch();
  show(location.hash.slice(1) || "start");
  for (const o of $("size").options) {
    const [f, d] = parseSize(o.value);
    o.textContent = t(SIZE_NAMES[o.value] || "{m} M ops/digit", { m: (countMacs({ filters: f, dense: d }) / 1e6).toFixed(1) });
  }
  const ready = once("ready"); worker.postMessage({ type: "init" });
  ready.then(({ backend }) => { $("bBackend").textContent = backend === "webgl" ? "GPU (WebGL)" : t("CPU only: training will be slow"); });
  const d = await dev.detect();
  S.onDevice = d.ok;
  $("bDevice").textContent = d.ok ? t("device {host} · {status}", { host: location.host, status: d.status }) : t("not on a device");
  if (d.ok) {
    dev.readConfig().catch(() => "").then(dev.meterName).then((name) => {
      if (!name) return;
      $("meterName").textContent = name; $("meterName").hidden = false;
      document.title = `${name} · ${baseTitle}`;
    });
  }
  await loadLlmSettings();
  S.model = await store.kvGet("lastModel");
  renderModel();
  await Promise.all([refreshSetup(), refreshProject()]);
  showUndo();
  renderSummary();
}
init();
