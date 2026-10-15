// Page logic. All TensorFlow.js work happens in src/worker.js so training keeps going
// when this tab is in the background.
import { loadDatasetZip, decodeBrowser } from "./dataset.js";
import { countMacs } from "./arch.js";
import TrainWorker from "./worker.js?worker&inline";

const $ = (id) => document.getElementById(id);
const state = { ds: null, history: [], testIdx: [], epochs: 0, training: false, trained: false };
const baseTitle = document.title;

// ---------- worker ----------
const worker = new TrainWorker();
const waiters = {};
const once = (type) => new Promise((res, rej) => { waiters[type] = { res, rej }; });
worker.onmessage = ({ data: m }) => {
  if (m.type === "progress") onProgress(m);
  else if (m.type === "epoch") onEpoch(m);
  else if (m.type === "error") {
    const w = Object.values(waiters)[0];
    Object.keys(waiters).forEach((k) => delete waiters[k]);
    w?.rej(new Error(m.message));
  } else if (waiters[m.type]) { const w = waiters[m.type]; delete waiters[m.type]; w.res(m); }
};
worker.onerror = (e) => status("trainStatus", `The training worker stopped: ${e.message}`, true);

async function initBackend() {
  const p = once("ready");
  worker.postMessage({ type: "init" });
  const { backend } = await p;
  $("bBackend").textContent = backend === "webgl" ? "GPU (WebGL)" : "CPU only: training will be slow";
  $("bWhere").textContent = location.protocol === "file:" ? "opened from disk" : `served by ${location.host}`;
}

// ---------- helpers ----------
function sizeOptions() {
  for (const o of $("size").options) {
    const [f, d] = parseSize(o.value);
    const m = countMacs({ filters: f, dense: d }) / 1e6;
    o.textContent = o.textContent.replace(/[\d.]+ M ops/, `${m.toFixed(1)} M ops`);
  }
}
const parseSize = (v) => v.split("|").map((s) => s.split(",").map(Number));
const enable = (id, on) => $(id).setAttribute("aria-disabled", on ? "false" : "true");
const setBar = (id, frac) => { $(id).style.width = `${Math.round(frac * 100)}%`; };
function status(id, text, bad = false) { const el = $(id); el.textContent = text; el.classList.toggle("bad", bad); }
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

// ---------- 1. data ----------
const drop = $("drop");
drop.addEventListener("click", () => $("file").click());
drop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("file").click(); } });
drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); if (e.dataTransfer.files[0]) loadZip(e.dataTransfer.files[0]); });
$("file").addEventListener("change", (e) => { if (e.target.files[0]) loadZip(e.target.files[0]); });

async function loadZip(file) {
  if (state.training) return;
  status("loadStatus", `Reading ${file.name} (${(file.size / 1e6).toFixed(1)} MB)…`);
  setBar("loadBar", 0);
  const t0 = performance.now();
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const ds = await loadDatasetZip(bytes, decodeBrowser, (d, n) => {
      setBar("loadBar", d / n);
      status("loadStatus", `Decoding crops ${d.toLocaleString()} / ${n.toLocaleString()}`);
    });
    // the pixels move to the worker; the page keeps labels and metadata
    worker.postMessage({ type: "data", X: ds.X, Y: ds.Y.slice() }, [ds.X.buffer]);
    state.ds = { rows: ds.rows, Y: ds.Y };
    status("loadStatus", `${ds.rows.length.toLocaleString()} crops loaded in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
    renderData(state.ds);
    enable("sTrain", true);
    $("btnTrain").disabled = false;
  } catch (e) {
    status("loadStatus", `Could not read the zip: ${e.message}`, true);
  }
}

const LABELS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "0/1", "1/2", "2/3", "3/4", "4/5", "5/6", "6/7", "7/8", "8/9", "9/0"];

function renderData(ds) {
  const groups = new Map();
  ds.rows.forEach((r) => {
    if (!groups.has(r.src)) groups.set(r.src, { train: 0, test: 0, labels: Object.fromEntries(LABELS.map((l) => [l, 0])) });
    const g = groups.get(r.src);
    g[r.split === "test" ? "test" : "train"]++;
    if (r.split !== "test" && r.label in g.labels) g.labels[r.label]++;
  });
  const head = `<tr><th>Source</th><th>Train</th><th>Test</th>${LABELS.map((l) => `<th>${l}</th>`).join("")}</tr>`;
  const body = [...groups].map(([k, g]) => `<tr><td>${k}</td><td>${g.train}</td><td>${g.test}</td>${
    LABELS.map((l) => { const n = g.labels[l]; return `<td class="${n < 15 ? "lo" : n < 40 ? "mid" : ""}">${n}</td>`; }).join("")}</tr>`).join("");
  $("dataTable").innerHTML = `<table><thead>${head}</thead><tbody>${body}</tbody></table>
    <p class="hint">Training crops per label. Red: under 15, too few to learn that position reliably.</p>`;
}

// ---------- 2. train ----------
function onProgress(m) {
  const frac = (m.epoch + m.step / m.steps) / state.epochs;
  setBar("trainBar", frac);
  document.title = `${Math.round(frac * 100)}% training · ${baseTitle}`;
}
function onEpoch(e) {
  state.history.push(e);
  drawChart();
  const left = (e.epochs - e.epoch - 1) * e.seconds;
  status("trainStatus", `Epoch ${e.epoch + 1}/${e.epochs}  loss ${e.loss.toFixed(3)}  validation loss ${e.valLoss.toFixed(3)}  ` +
    `validation accuracy ${(e.valAcc * 100).toFixed(1)}%  ${e.seconds.toFixed(1)} s/epoch  about ${Math.ceil(left / 60)} min left`);
}

$("btnStop").addEventListener("click", () => { worker.postMessage({ type: "stop" }); status("trainStatus", "Stopping after this batch…"); });
$("btnTrain").addEventListener("click", async () => {
  const ds = state.ds;
  const [filters, dense] = parseSize($("size").value);
  const epochs = +$("epochs").value, batch = +$("batch").value, lr = +$("lr").value;
  const trainAll = [], testIdx = [];
  ds.rows.forEach((r, i) => (r.split === "test" ? testIdx : trainAll).push(i));
  // 8% of the training crops (random) pick the best epoch
  const shuffled = shuffle(trainAll.slice());
  const nVal = Math.max(1, Math.round(shuffled.length * 0.08));
  state.history = []; state.testIdx = testIdx; state.epochs = epochs; state.training = true;
  $("btnTrain").disabled = true; $("btnStop").disabled = false; $("trainNote").hidden = false;
  status("trainStatus", `Training on ${(shuffled.length - nVal).toLocaleString()} crops…`);
  const t0 = performance.now();
  try {
    const done = once("trained");
    worker.postMessage({ type: "train", filters, dense, epochs, batch, lr,
      trainIdx: shuffled.slice(nVal), valIdx: shuffled.slice(0, nVal), testIdx });
    const res = await done;
    const mins = ((performance.now() - t0) / 60000).toFixed(1);
    status("trainStatus", `Done in ${mins} min. Kept epoch ${res.bestEpoch + 1} (lowest validation loss ${res.bestValLoss.toFixed(3)}).`);
    setBar("trainBar", 1);
    document.title = `Done · ${baseTitle}`;
    renderEval(res.probs);
    state.trained = true;
    enable("sExport", true); $("btnExport").disabled = false;
    $("fname").value = `dig-browser-f${filters[0]}_${new Date().toISOString().slice(0, 10).replaceAll("-", "")}_q.tflite`;
  } catch (e) {
    status("trainStatus", `Training failed: ${e.message}`, true);
    document.title = baseTitle;
  } finally {
    state.training = false;
    $("btnTrain").disabled = false; $("btnStop").disabled = true; $("trainNote").hidden = true;
  }
});

function drawChart() {
  const c = $("chart"), ctx = c.getContext("2d");
  const W = c.width, H = c.height, h = state.history;
  const css = getComputedStyle(document.documentElement);
  ctx.clearRect(0, 0, W, H);
  if (!h.length) return;
  const max = Math.max(...h.map((e) => Math.max(e.loss, e.valLoss)));
  const x = (i) => 30 + (i / Math.max(1, state.epochs - 1)) * (W - 40);
  const y = (v) => H - 14 - (v / max) * (H - 28);
  ctx.fillStyle = css.getPropertyValue("--muted"); ctx.font = "11px sans-serif";
  ctx.fillText(max.toFixed(2), 2, 14); ctx.fillText("0", 2, H - 10);
  for (const [key, color] of [["loss", "--accent"], ["valLoss", "--warn"]]) {
    ctx.strokeStyle = css.getPropertyValue(color); ctx.lineWidth = 2; ctx.beginPath();
    h.forEach((e, i) => (i ? ctx.lineTo(x(i), y(e[key])) : ctx.moveTo(x(i), y(e[key]))));
    ctx.stroke();
  }
}

// ---------- 3. evaluate ----------
function renderEval(p) {
  enable("sEval", true);
  const { rows, Y } = state.ds, testIdx = state.testIdx;
  if (!testIdx.length) { $("evalTable").innerHTML = `<p class="hint">The dataset has no test crops.</p>`; return; }
  const g = new Map();
  testIdx.forEach((r, k) => {
    const row = rows[r];
    const key = `${row.src} dig${row.pos}`;
    let am = 0;
    for (let c = 1; c < 10; c++) if (p[k * 10 + c] > p[k * 10 + am]) am = c;
    const ok = Y[r * 10 + am] >= 0.5;
    const e = g.get(key) || { d: 0, dOk: 0, t: 0, tOk: 0 };
    if (row.label.includes("/")) { e.t++; e.tOk += ok; } else { e.d++; e.dOk += ok; }
    g.set(key, e);
  });
  const pct = (a, n) => (n ? `${((a / n) * 100).toFixed(1)}%` : "–");
  const cls = (a, n) => (!n ? "" : a / n < 0.95 ? "lo" : a / n < 0.99 ? "mid" : "ok");
  const body = [...g].sort().map(([k, e]) => `<tr><td>${k}</td><td>${e.d}</td><td class="${cls(e.dOk, e.d)}">${pct(e.dOk, e.d)}</td>` +
    `<td>${e.t}</td><td class="${cls(e.tOk, e.t)}">${pct(e.tOk, e.t)}</td></tr>`).join("");
  $("evalTable").innerHTML = `<table><thead><tr><th>Wheel</th><th>Digits</th><th>Correct</th><th>Transitions</th><th>Correct</th></tr></thead><tbody>${body}</tbody></table>`;
}

// ---------- 4. export ----------
$("btnExport").addEventListener("click", async () => {
  status("exportStatus", "Calibrating and quantizing…");
  try {
    const ds = state.ds;
    const trainRows = ds.rows.map((r, i) => i).filter((i) => ds.rows[i].split !== "test");
    const name = $("fname").value.trim() || "dig-browser_q.tflite";
    const done = once("exported");
    worker.postMessage({ type: "export", name, calibIdx: shuffle(trainRows).slice(0, 300) });
    const { bytes } = await done;
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
    const el = $("exportStatus");
    el.classList.remove("bad");
    el.innerHTML = `${(bytes.length / 1024).toFixed(0)} KB int8 model. <a class="dl" href="${url}" download="${name}">Download ${name}</a>`;
  } catch (e) {
    status("exportStatus", `Export failed: ${e.message}`, true);
  }
});

window.addEventListener("beforeunload", (e) => { if (state.training) { e.preventDefault(); e.returnValue = ""; } });

sizeOptions();
initBackend();
