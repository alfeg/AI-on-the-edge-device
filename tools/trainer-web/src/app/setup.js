// Step 1: the device's configuration checks and their one-click fixes.
import { markRaw, reactive } from "vue";
import * as dev from "../device.js";
import { configChecks } from "../readiness.js";
import { t } from "../i18n.js";
import { app, setPill, say, logHead, runTask } from "./state.js";

export const setup = reactive({
  cfg: null,        // config.ini text as last read
  checks: [],       // [{ level, title, detail, fix?: { label, apply(cfg) } }]
  confirm: null,    // index of the check whose fix waits for "Change and restart"
});

export async function refreshSetup() {
  if (!app.onDevice) { setPill("setup", "not on a device", "warn"); return; }
  try { setup.cfg = await dev.readConfig(); } catch (e) { say("setup", t("Could not read the configuration: {err}", { err: e.message }), true); return; }
  setup.checks = markRaw(configChecks(setup.cfg));
  const worst = setup.checks.some((c) => c.level === "block") ? "block" : setup.checks.some((c) => c.level === "warn") ? "warn" : "ok";
  setPill("setup", { block: "action needed", warn: "check", ok: "ready" }[worst], { block: "bad", warn: "warn", ok: "ok" }[worst]);
}

export async function applyFix(i) {
  setup.confirm = null;
  const fix = setup.checks[i].fix;
  await runTask("device setup", "setup", async () => {
    logHead("setup", fix.label);
    const backup = await dev.writeConfigAndReboot(fix.apply(setup.cfg), (s) => say("setup", s));
    await dev.waitForReading((s) => say("setup", s));
    say("setup", t("Done. The previous configuration is saved as {file}.", { file: backup }));
  }, (err) => t("The change did not complete: {err}", { err }));
  refreshSetup();
}
