<!-- Step 4: train a model in this browser and compare it with the installed one. -->
<script setup>
import { t, N_ } from "../../i18n.js";
import { HINT } from "../../hints.js";
import { countMacs } from "../../arch.js";
import { app, runTask, requestStop } from "../../app/state.js";
import { train, runTrain } from "../../app/training.js";
import { LOC, parseSize } from "../../app/format.js";
import StepPill from "../common/StepPill.vue";
import StatusLine from "../common/StatusLine.vue";
import ProgressBar from "../common/ProgressBar.vue";
import LossChart from "../train/LossChart.vue";
import CompareTable from "../train/CompareTable.vue";

const SIZES = [
  ["24,48,48|128,64", N_("Small · {m} M ops/digit")],
  ["32,64,64|128,64", N_("Medium · {m} M ops/digit")],
  ["64,128,64|256,64", N_("Large · {m} M ops/digit (slow on the device)")],
].map(([value, name]) => {
  const [filters, dense] = parseSize(value);
  const m = (countMacs({ filters, dense }) / 1e6).toLocaleString(LOC, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return { value, name: t(name, { m }) };
});

const start = () => runTask("training", "train", runTrain, (err) => t("Training failed: {err}", { err }));
</script>

<template>
  <h2>{{ t("Train") }} <StepPill step="train" /></h2>
  <div class="row">
    <label class="f" for="size" :data-hint="HINT.modelSize">{{ t("Model size") }}
      <select id="size" v-model="train.size"><option v-for="s in SIZES" :key="s.value" :value="s.value">{{ s.name }}</option></select>
    </label>
    <label class="f" for="epochs" :data-hint="HINT.epochs">{{ t("Epochs") }} <input id="epochs" v-model.number="train.epochs" type="number" min="1" max="300"></label>
    <label class="f" for="batch" :data-hint="HINT.batch">{{ t("Batch") }} <input id="batch" v-model.number="train.batch" type="number" min="8" max="512" step="8"></label>
    <label class="f" for="lr" :data-hint="HINT.lr">{{ t("Learning rate") }} <input id="lr" v-model.number="train.lr" type="number" step="0.0001" min="0.00001"></label>
  </div>
  <div class="row opts">
    <label class="c"><input v-model="train.useUnconfirmed" type="checkbox"> {{ t("Also train on unconfirmed labels (faster, but can repeat the device’s mistakes)") }}</label>
    <label class="c" :data-hint="HINT.finalAll"><input v-model="train.finalAll" type="checkbox"> {{ t("Then train the final model on all images (takes twice as long)") }}</label>
  </div>
  <div class="row">
    <button id="btnTrain" class="primary" :disabled="!!app.busy" @click="start">{{ t("Start training") }}</button>
    <button id="btnStop" :disabled="app.task !== 'training'" @click="requestStop">{{ t("Stop") }}</button>
  </div>
  <ProgressBar :value="train.bar" />
  <StatusLine id="trainStatus" where="train" />
  <LossChart />
  <CompareTable />
</template>
