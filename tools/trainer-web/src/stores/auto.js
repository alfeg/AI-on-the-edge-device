// Automatic run: steps 2 to 5 in a row; installs only when the new model is at least as good.
import { reactive } from "vue";
import { MIN_COMPARE } from "@/lib/readiness.js";
import { t } from "@/i18n/index.js";
import { app, say, runTask } from "@/stores/app.js";
import { cov } from "@/stores/project.js";
import { setup, refreshSetup } from "@/stores/setup.js";
import { runCollect } from "@/stores/collect.js";
import { runLlm } from "@/stores/ai.js";
import { runTrain, verdictOf } from "@/stores/train.js";
import { runInstall } from "@/stores/install.js";
import { pct1 } from "@/utils/format.js";

export const auto = reactive({
  llm: false,       // ask the AI server for labels
  llmN: 200,
  install: false,   // install when at least as good
});

class Stopped extends Error { constructor() { super("stopped"); } }
const checkStop = () => { if (app.stop) throw new Stopped(); };

export async function runAuto() {
  const say_ = (text, bad) => say("auto", text, bad);
  await runTask("automatic run", "auto", async () => {
    try {
      if (app.onDevice) {
        await refreshSetup();
        if (setup.checks.some((c) => c.level === "block")) throw new Error(t("fix the device setup in step 1 first"));
        say_(t("Step 2: collecting new images…")); await runCollect();
      }
      checkStop();
      if (auto.llm) { say_(t("Step 3: asking the AI server for labels…")); await runLlm(auto.llmN || 200); }
      checkStop();
      if (cov.value.verdict === "blocked") throw new Error(t("no images to train on"));
      say_(t(cov.value.verdict === "not-enough" ? "Step 4: training (with less data than recommended)…" : "Step 4: training…"));
      const m = await runTrain();
      checkStop();
      const v = verdictOf(m);
      if (v === "worse") { say_(t("Finished. On the same test images the new model read {a}%, the installed one {b}%: not installed.", { a: pct1(m.accOnDev), b: pct1(m.devAcc) })); return; }
      if (v === "unknown") { say_(t("Finished. Too few test images from this device to compare with the installed model ({n} of {min}), so it was not installed automatically. Install it in step 5 if you want.", { n: m.compareN, min: MIN_COMPARE })); return; }
      if (!auto.install || !app.onDevice) { say_(t("Finished. The new model is ready to install in step 5.")); return; }
      say_(t("Step 5: installing the new model…")); await runInstall();
      say_(t("Finished: the new model is installed and reading."));
    } catch (e) {
      const stopped = e instanceof Stopped;
      say_(t("Automatic run stopped: {err}", { err: stopped ? t("stopped") : e.message }), !stopped);
    }
  });
}
