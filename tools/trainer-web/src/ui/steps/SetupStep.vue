<!-- Step 1: does the device save digit images, and keep them long enough? -->
<script setup>
import { t } from "../../i18n.js";
import { app } from "../../app/state.js";
import { setup, applyFix } from "../../app/setup.js";
import StepPill from "../common/StepPill.vue";
import LogPanel from "../common/LogPanel.vue";
</script>

<template>
  <h2>{{ t("Device setup") }} <StepPill step="setup" /></h2>
  <ul id="checks" class="checks">
    <li v-if="!app.onDevice" class="lv-warn">
      <span class="dot"></span><span class="t">{{ t("This page is not served by an AI-on-the-edge device") }}</span>
      <span class="d">{{ t("Upload trainer.html.gz to /html/ on the device and open http://<device>/trainer.html to collect images and install models. Importing a dataset zip and training work here too.") }}</span>
    </li>
    <li v-for="(c, i) in app.onDevice ? setup.checks : []" :key="i" :class="`lv-${c.level}`">
      <span class="dot"></span><span class="t">{{ c.title }}</span>
      <button v-if="c.fix" class="primary" :disabled="!!app.busy" @click="setup.confirm = i">{{ c.fix.label }}</button><span v-else></span>
      <span class="d">{{ c.detail || "" }}</span>
      <span v-if="c.fix && setup.confirm === i" class="confirm d">{{ t("This changes the configuration and restarts the device once.") }}
        <button class="primary" :disabled="!!app.busy" @click="applyFix(i)">{{ t("Change and restart") }}</button>
        <button @click="setup.confirm = null">{{ t("Cancel") }}</button>
      </span>
    </li>
  </ul>
  <LogPanel id="setupStatus" where="setup" />
</template>
