<!-- The page: header readout, step rail, the running task, one step at a time. -->
<script setup>
import { onMounted, ref, watch } from "vue";
import { t, LANG, LANGS, setLang } from "@/i18n/index.js";
import * as dev from "@/services/device.js";
import { app, go, STEPS, STEP_NAMES, pills, pillText, pillTip, stepOf } from "@/stores/app.js";
import { refreshProject } from "@/stores/project.js";
import { refreshSetup } from "@/stores/setup.js";
import { loadAiSettings } from "@/stores/ai.js";
import { initWorker, loadLastModel } from "@/stores/train.js";
import { loadInstalls } from "@/stores/install.js";
import StartView from "@/views/StartView.vue";
import SetupView from "@/views/SetupView.vue";
import CollectView from "@/views/CollectView.vue";
import LabelsView from "@/views/LabelsView.vue";
import TrainView from "@/views/TrainView.vue";
import InstallView from "@/views/InstallView.vue";
import StepNav from "@/components/StepNav.vue";

const SECTIONS = { start: ["sAuto", StartView], setup: ["sSetup", SetupView], collect: ["sCollect", CollectView], labels: ["sLabels", LabelsView], train: ["sTrain", TrainView], install: ["sInstall", InstallView] };
const otherLang = LANG === "ru" ? "en" : "ru";
const header = ref(null), nav = ref(null);

function switchLang() {
  if (!app.busy || confirm(t("Switching the language reloads the page and stops “{task}”. Continue?", { task: app.busy }))) setLang(otherLang);
}

// the URL hash names the open step
watch(() => app.step, (step) => {
  if (location.hash !== `#${step}`) history.replaceState(null, "", `#${step}`);
  // keep the step rail where it is: if it is pinned to the top, open the new step right
  // under it; otherwise don't scroll at all (jumping to the top made the page lurch)
  const railTop = header.value.getBoundingClientRect().bottom + scrollY + parseFloat(getComputedStyle(nav.value.parentElement).rowGap || "0");
  if (scrollY > railTop) window.scrollTo({ top: railTop, behavior: "instant" });
}, { flush: "post" });

// the guided review's group bar docks under the step rail
const setNavH = () => document.documentElement.style.setProperty("--navh", `${nav.value.offsetHeight}px`);

onMounted(async () => {
  setNavH(); addEventListener("resize", setNavH);
  addEventListener("hashchange", () => go(location.hash.slice(1)));
  addEventListener("beforeunload", (e) => { if (app.busy) { e.preventDefault(); e.returnValue = ""; } });
  go(location.hash.slice(1) || "start");

  initWorker().then((backend) => { app.backendText = backend === "webgl" ? "GPU (WebGL)" : t("CPU only: training will be slow"); });
  const d = await dev.detect();
  app.onDevice = d.ok;
  app.deviceText = d.ok ? t("device {host} · {status}", { host: location.host, status: d.status }) : t("not on a device");
  if (d.ok) dev.readConfig().catch(() => "").then(dev.meterName).then((name) => { if (name) app.meterName = name; });
  await loadAiSettings();
  await loadLastModel();
  await Promise.all([refreshSetup(), refreshProject()]);
  loadInstalls();
});
</script>

<template>
  <div class="wrap">
    <header ref="header">
      <h1>{{ t("Meter model trainer") }}<span v-if="app.meterName" id="meterName">{{ app.meterName }}</span></h1>
      <div class="badges">
        <span id="bDevice">{{ app.deviceText }}</span><span id="bBackend">{{ app.backendText }}</span><span>v0.5</span>
        <button type="button" class="link lang" :lang="otherLang" @click="switchLang">{{ LANGS[otherLang] }}</button>
      </div>
    </header>

    <nav id="steps" ref="nav" class="steps" :aria-label="t('Steps')">
      <button v-for="(s, i) in STEPS" :key="s" type="button" :data-step="s" :aria-current="app.step === s ? 'step' : null" @click="go(s)">
        <span class="sn">{{ i }}</span>{{ STEP_NAMES[s] }}<span class="np" :class="pills[s].kind" :data-hint="pillTip(s)">{{ pillText(s) }}</span>
      </button>
    </nav>
    <div v-if="app.busy" id="activity" class="activity">
      <span>{{ app.activity }}</span><button class="link" type="button" @click="go(stepOf(app.where))">{{ t("Show") }}</button>
    </div>

    <section v-for="(sec, s) in SECTIONS" v-show="app.step === s" :id="sec[0]" :key="s" :data-step="s">
      <component :is="sec[1]" />
      <StepNav :step="s" />
    </section>

    <footer class="foot"><span>{{ t("Meter model trainer") }}</span><a href="https://github.com/alfeg" target="_blank" rel="noopener">github.com/alfeg</a></footer>
  </div>
</template>
