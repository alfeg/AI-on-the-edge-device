// App-wide state: the open step, the one task that may run at a time, status lines and
// the status word ("pill") of every step.
import { reactive, watchEffect } from "vue";
import { t } from "@/i18n/index.js";
import { pillHint } from "@/i18n/hints.js";
import { hhmmss } from "@/utils/format.js";

export const STEPS = ["start", "setup", "collect", "labels", "train", "install"];
export const STEP_NAMES = { start: t("Start"), setup: t("Device"), collect: t("Collect"), labels: t("Labels"), train: t("Train"), install: t("Install") };

export const app = reactive({
  step: "start",
  onDevice: false,
  deviceText: t("device …"),
  backendText: t("backend …"),
  meterName: "",
  // the running task: its translated name, where its messages go, and the stop request
  busy: null, task: null, where: null, stop: false,
  activity: "",
  progress: "", // short progress for the tab title, e.g. "42% training"
});

export function go(step) { app.step = STEPS.includes(step) ? step : "start"; }

// tab title: progress first (visible in a background tab), then the meter's name
watchEffect(() => { document.title = [app.progress, app.meterName, t("Meter Model Trainer")].filter(Boolean).join(" · "); });

// ---------------------------------------------------------------- step status words
/** Per step: the English word (picks the hint, translated when shown), colour and placeholders. */
export const pills = reactive({
  start: { text: "overview", kind: "" },
  setup: { text: "checking", kind: "" },
  collect: { text: "–", kind: "" },
  labels: { text: "–", kind: "" },
  train: { text: "–", kind: "" },
  install: { text: "–", kind: "" },
});
export function setPill(step, text, kind = "", vars) { pills[step] = { text, kind, vars }; }
export const pillText = (step) => t(pills[step].text, pills[step].vars);
/** The element id of a step's pill (also what i18n/hints.js knows it by). */
export const pillId = (step) => `${step === "start" ? "auto" : step}Pill`;
export const pillTip = (step) => pillHint(pillId(step), pills[step].text);

// ---------------------------------------------------------------- status lines and logs
/** One-line statuses, by place: "auto", "collect", "llm", "train", "verdict", "rev". */
export const lines = reactive({ auto: {}, collect: {}, llm: {}, train: {}, verdict: {}, rev: {} });
/** Logs with timestamps (device setup and install). */
export const logs = reactive({ setup: [], install: [] });
const WHERE_STEP = { setup: "setup", collect: "collect", llm: "labels", rev: "labels", train: "train", install: "install", auto: "start" };
export const stepOf = (where) => WHERE_STEP[where] || "start";

// progress messages that only differ in numbers/times update their own line
const logKey = (text) => text.split(" (")[0].replace(/[\d:.,()]+/g, "").replace(/\s+/g, " ").trim();
function logLine(log, text, bad) {
  const last = log.at(-1), key = logKey(text);
  if (last && !last.head && last.key === key) { last.text = text; last.bad = bad; return; }
  log.push({ time: hhmmss(), text, bad, key });
}
export function logHead(where, text) { logs[where].push({ time: hhmmss(), text, head: true }); }

/** Shows a message where a task reports (a status line or a log). */
export function say(where, text, bad = false) {
  if (where in logs) logLine(logs[where], text, bad);
  else lines[where] = { text, bad };
  if (app.busy && (where === app.where || where === "auto")) app.activity = `${app.busy}: ${text}`;
}

// ---------------------------------------------------------------- one task at a time
/**
 * Runs fn as the one task of the page; while it runs, every action button is disabled.
 * name is English (translated here); fail(err) gives the message shown when fn throws.
 * Resolves false when another task was running.
 */
export async function runTask(name, where, fn, fail) {
  if (app.busy) { say(where, t("Wait for “{task}” to finish first.", { task: app.busy }), true); return false; }
  Object.assign(app, { busy: t(name), task: name, where, stop: false, activity: `${t(name)}…` });
  try { await fn(); } catch (e) {
    if (!fail) throw e;
    say(where, fail(e.message || String(e)), true);
  } finally { Object.assign(app, { busy: null, task: null, progress: "" }); }
  return true;
}

const stopHooks = [];
/** Lets a module stop its own work too (the training worker). */
export function onStop(fn) { stopHooks.push(fn); }
export function requestStop() { app.stop = true; stopHooks.forEach((fn) => fn()); }
