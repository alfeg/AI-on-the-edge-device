<!-- Start: what the page does, where each step stands, and the automatic run. -->
<script setup>
import { t } from "@/i18n/index.js";
import { app, go, STEPS, STEP_NAMES, pillText, pillTip, requestStop } from "@/stores/app.js";
import { auto, runAuto } from "@/stores/auto.js";
import StepPill from "@/components/StepPill.vue";
import BaseStatusLine from "@/components/BaseStatusLine.vue";
</script>

<template>
  <h2>{{ t("Train a better digit model") }} <StepPill step="start" /></h2>
  <p class="hint">{{ t("This page collects the digit images the device saves, labels them, trains a new digit model in this browser and installs it on the device. Images stay in this browser; they only go to an AI server if you set one up in step 3. Go through the steps one by one, or let the automatic run do steps 2 to 5.") }}</p>
  <div class="summary">
    <button v-for="(s, i) in STEPS.slice(1)" :key="s" type="button" @click="go(s)">
      {{ i + 1 }} · {{ STEP_NAMES[s] }}<span :data-hint="pillTip(s)">{{ pillText(s) }}</span>
    </button>
  </div>

  <h3>{{ t("Automatic run") }}</h3>
  <div class="row opts">
    <label class="c"><input v-model="auto.llm" type="checkbox"> {{ t("Ask the AI server to label up to") }} <input v-model.number="auto.llmN" type="number" min="10" step="10"> {{ t("images") }}</label>
    <label class="c"><input v-model="auto.install" type="checkbox"> {{ t("Install the new model when it is at least as good") }}</label>
  </div>
  <div class="row">
    <button id="btnAuto" class="primary" :disabled="!!app.busy" @click="runAuto">{{ t("Run steps 2 to 5") }}</button>
    <button id="btnAutoStop" :disabled="app.task !== 'automatic run'" @click="requestStop">{{ t("Stop") }}</button>
  </div>
  <BaseStatusLine id="autoStatus" where="auto" />
  <p v-show="app.busy" class="note">{{ t("Work continues while this tab is in the background; progress shows in the tab title. Keep the tab open and the computer awake.") }}</p>
</template>
