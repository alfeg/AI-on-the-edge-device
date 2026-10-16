<!-- Step 5: install the trained model on the device (or download it), and undo. -->
<script setup>
import { ref } from "vue";
import { t, tHtml } from "@/i18n/index.js";
import { app, runTask } from "@/stores/app.js";
import { setup, refreshSetup } from "@/stores/setup.js";
import { train } from "@/stores/train.js";
import { install, runInstall, runUndo, installQuestion, canInstall } from "@/stores/install.js";
import { saveFile } from "@/utils/format.js";
import StepPill from "@/components/StepPill.vue";
import BaseLogPanel from "@/components/BaseLogPanel.vue";

const question = ref(""); // the confirmation, while it is open

const download = () => saveFile(install.fname.trim() || train.model.name, train.model.bytes, "application/octet-stream");
async function doInstall() {
  question.value = "";
  await runTask("install", "install", runInstall, (err) => t("Install did not complete: {err}", { err }));
  refreshSetup();
}
async function undo() {
  await runTask("undo", "install", runUndo, (err) => t("Undo did not complete: {err}", { err }));
  refreshSetup();
}
</script>

<template>
  <h2>{{ t("Install on the device") }} <StepPill step="install" /></h2>
  <div class="row">
    <label class="f" for="fname">{{ t("File name") }} <input id="fname" v-model="install.fname" type="text" class="wide"></label>
    <button id="btnInstall" class="primary" :disabled="!!app.busy || !canInstall()" @click="question = installQuestion(setup.cfg)">{{ t("Install and use this model") }}</button>
    <button id="btnDownload" :disabled="!train.model" @click="download">{{ t("Download .tflite") }}</button>
  </div>
  <div v-if="question" class="confirm"><span>{{ question }}</span>
    <button class="primary" @click="doInstall">{{ t("Install") }}</button><button @click="question = ''">{{ t("Cancel") }}</button>
  </div>
  <BaseLogPanel id="installStatus" where="install" />
  <div class="more">
    <button v-if="install.lastInstall && app.onDevice" class="link" type="button" :disabled="!!app.busy" @click="undo">
      {{ t("Go back to {file}", { file: install.lastInstall.prev.split("/").pop() }) }}
    </button>
  </div>
  <p class="hint" v-html="tHtml('installHint', 'Installing uploads the model to <code>/config/</code>, saves a copy of the configuration next to it, switches the digit model right after a reading round and restarts the device, then waits for its first reading. The previous model file stays on the card.')"></p>
</template>
