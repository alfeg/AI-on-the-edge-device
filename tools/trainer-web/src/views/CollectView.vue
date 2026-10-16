<!-- Step 2: copy the device's digit images into this browser; import / export datasets. -->
<script setup>
import { computed, ref } from "vue";
import { t } from "@/i18n/index.js";
import { HINT } from "@/i18n/hints.js";
import { app, runTask, requestStop } from "@/stores/app.js";
import { collect, FILES_PER_S, runScan, runDownload, perWheel, importZip, clearAll } from "@/stores/collect.js";
import { train } from "@/stores/train.js";
import { exportCsv, exportZip } from "@/stores/datasetExport.js";
import { fmtTime, num } from "@/utils/format.js";
import StepPill from "@/components/StepPill.vue";
import BaseStatusLine from "@/components/BaseStatusLine.vue";
import BaseProgressBar from "@/components/BaseProgressBar.vue";
import BaseHintTh from "@/components/BaseHintTh.vue";

const plan = computed(() => collect.plan);
const wheels = computed(() => (plan.value ? perWheel(plan.value, collect.quota) : []));
const collecting = computed(() => app.task === "checking the device" || app.task === "collect");
const fileInput = ref(null), confirmClear = ref(false);

const scan = () => runTask("checking the device", "collect", runScan, (err) => t("Checking failed: {err}", { err }));
const download = () => runTask("collect", "collect", runDownload, (err) => t("Collecting failed: {err}", { err }));
async function onFile(e) {
  const f = e.target.files[0];
  if (f) await runTask("import", "collect", () => importZip(f), (err) => t("Import failed: {err}", { err }));
  e.target.value = "";
}
async function clear() {
  confirmClear.value = false;
  await clearAll();
  train.model = null;
}
</script>

<template>
  <h2>{{ t("Collect images") }} <StepPill step="collect" /></h2>
  <p class="hint">{{ t("Copies the digit images the device saved into this browser. Checking first lists the device’s folders and shows how much there is to download. Images are grouped by wheel and by what the device read (a digit, a position between two digits, or a rejected reading); of each group only “images per reading” are kept, spread over the days. A wheel at rest shows the same digit for days, so most of its images are skipped. The device sends about three images a second.") }}</p>
  <div class="row">
    <label class="f" for="days" :data-hint="HINT.daysBack">{{ t("Days back") }} <input id="days" v-model.number="collect.days" type="number" min="1" max="60"></label>
    <label class="f" for="quota" :data-hint="HINT.perReading">{{ t("Images per reading") }} <input id="quota" v-model.number="collect.quota" type="number" min="10" max="2000" step="10"></label>
    <button id="btnScan" :disabled="!!app.busy" @click="scan">{{ t("Check for new images") }}</button>
    <button id="btnCollect" class="primary" :disabled="!!app.busy || !plan?.toFetch" @click="download">
      {{ !plan ? t("Download") : plan.toFetch ? t("Download {n} images", { n: num(plan.toFetch) }) : t("Nothing new to download") }}
    </button>
    <button id="btnCollectStop" :disabled="!collecting" @click="requestStop">{{ t("Stop") }}</button>
  </div>

  <div v-if="plan" id="plan" class="plan">
    <div><b>{{ num(plan.toFetch) }}</b><span>{{ t("new images to download") }}</span></div>
    <div><b>{{ t("about {time}", { time: fmtTime(plan.toFetch / FILES_PER_S) }) }}</b><span>{{ t("at about {n} images/s", { n: FILES_PER_S }) }}</span></div>
    <div><b>{{ num(plan.onDevice) }}</b><span>{{ t("images in {n} new hour folders on the device", { n: plan.listed }) }}</span></div>
    <div><b>{{ num(plan.skippedEnough) }}</b><span>{{ t("skipped: enough images of that reading already") }}</span></div>
    <div><b>{{ num(plan.have) }}</b><span>{{ t("already here") }}{{ plan.knownHours ? t(", plus {n} hours collected earlier", { n: plan.knownHours }) : "" }}</span></div>
    <details class="pw">
      <summary>{{ t("Per wheel") }}</summary>
      <div class="tw">
        <table>
          <thead><tr>
            <BaseHintTh :label="t('Wheel')" :hint="HINT.wheel" /><BaseHintTh :label="t('To download')" :hint="HINT.toDownload" /><BaseHintTh :label="t('Skipped')" :hint="HINT.skipped" />
            <BaseHintTh :label="t('Readings full')" :hint="HINT.readingsFull" /><BaseHintTh :label="t('Readings still short')" :hint="HINT.readingsShort" />
          </tr></thead>
          <tbody><tr v-for="w in wheels" :key="w.roi"><td>{{ w.roi }}</td><td>{{ w.picked }}</td><td>{{ w.skipped }}</td><td>{{ w.full }}</td><td>{{ w.open }}</td></tr></tbody>
        </table>
      </div>
    </details>
  </div>
  <BaseProgressBar :value="collect.bar" />
  <BaseStatusLine id="collectStatus" where="collect" />

  <div class="more">
    <button class="link" type="button" :disabled="!!app.busy" @click="fileInput.click()">{{ t("Import a labelled dataset zip") }}</button>
    <input id="fileZip" ref="fileInput" type="file" accept=".zip" hidden @change="onFile">
    <button class="link" type="button" :disabled="!!app.busy" @click="exportZip('collect')">{{ t("Export dataset (zip with images)") }}</button>
    <button class="link" type="button" :disabled="!!app.busy" @click="exportCsv('collect')">{{ t("Export labels (CSV)") }}</button>
    <button class="link danger" type="button" :disabled="!!app.busy" @click="confirmClear = true">{{ t("Delete all collected data") }}</button>
  </div>
  <div v-if="confirmClear" class="confirm">{{ t("Delete all images, labels and models stored in this browser?") }}
    <button class="danger" @click="clear">{{ t("Delete") }}</button><button @click="confirmClear = false">{{ t("Keep") }}</button>
  </div>
</template>
