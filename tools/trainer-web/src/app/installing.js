// Step 5: upload the model, switch [Digits] Model, restart, wait for a reading; undo.
import { reactive, watch } from "vue";
import * as dev from "../device.js";
import * as store from "../store.js";
import { getKey, setKey } from "../ini.js";
import { t } from "../i18n.js";
import { app, setPill, say, logHead } from "./state.js";
import { train } from "./training.js";
import { LOC } from "./format.js";

export const install = reactive({
  fname: "",       // file name on the card, from the model
  lastInstall: null, // { at, model, prev, backup } of the newest install, for undo
});

// a new model: offer its name, show its date
watch(() => train.model, (m) => {
  if (m) install.fname = m.name;
  setPill("install", m ? "model of {date}" : "no model yet", "", { date: m ? new Date(m.at).toLocaleString(LOC, { dateStyle: "short", timeStyle: "short" }) : "" });
}, { immediate: true });

export async function loadInstalls() { install.lastInstall = (await store.kvGet("installs", [])).at(-1) ?? null; }

export async function runInstall() {
  const m = train.model;
  const name = (install.fname.trim() || m.name).replace(/[^\w.-]/g, "_");
  const path = `/config/${name.endsWith(".tflite") ? name : `${name}.tflite`}`;
  const log = (s) => say("install", s);
  logHead("install", t("Install {file}", { file: path }));
  log(t("Uploading the model ({kb} KB)…", { kb: (m.bytes.length / 1024).toFixed(0) }));
  await dev.upload(path, m.bytes);
  log(t("Model uploaded and checked (MD5)."));
  const cfg = await dev.readConfig();
  const prev = getKey(cfg, "Digits", "Model")?.value;
  const backup = await dev.writeConfigAndReboot(setKey(cfg, "Digits", "Model", path), log);
  const v = await dev.waitForReading(log);
  const first = Object.values(v)[0];
  const hist = await store.kvGet("installs", []);
  hist.push({ at: Date.now(), model: path, prev, backup });
  await store.kvSet("installs", hist);
  log(t("Installed. First reading with {file}: {v} ({err}). Previous model: {prev}; configuration copy: {backup}.", { file: path, v: first?.value, err: first?.error, prev, backup }));
  setPill("install", "installed", first?.error === "no error" ? "ok" : "warn");
  await loadInstalls();
}

export async function runUndo() {
  const hist = await store.kvGet("installs", []);
  const last = hist.at(-1);
  const log = (s) => say("install", s);
  logHead("install", t("Go back to {file}", { file: last.prev }));
  const cfg = await dev.readConfig();
  await dev.writeConfigAndReboot(setKey(cfg, "Digits", "Model", last.prev), log);
  const v = await dev.waitForReading(log);
  hist.pop(); await store.kvSet("installs", hist);
  log(t("Back on {file}. Reading: {v}.", { file: last.prev, v: Object.values(v)[0]?.value }));
  await loadInstalls();
}

/** Text for the install confirmation. */
export function installQuestion(cfg) {
  const m = train.model;
  const cur = cfg ? getKey(cfg, "Digits", "Model")?.value : "?";
  return t("Replace {cur} with {new}? The device restarts once.", { cur, new: install.fname.trim() || m.name }) + " " +
    (m.devAcc != null ? t("Test images: new {a}%, current {b}%.", { a: (m.accOnDev * 100).toFixed(1), b: (m.devAcc * 100).toFixed(1) }) : t("The models were not compared (too few test images from this device)."));
}

export const canInstall = () => !!train.model && app.onDevice;
