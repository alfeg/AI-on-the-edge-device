<!-- Step 3: how many usable labels there are, AI labelling, and the review. -->
<script setup>
import { ref } from "vue";
import { t } from "@/i18n/index.js";
import StepPill from "@/components/StepPill.vue";
import LabelsCoverageTable from "@/components/labels/LabelsCoverageTable.vue";
import LabelsAiServer from "@/components/labels/LabelsAiServer.vue";
import LabelsReviewPanel from "@/components/labels/LabelsReviewPanel.vue";
import LabelsKeyDrawer from "@/components/labels/LabelsKeyDrawer.vue";

const reviewHead = ref(null);
const toReview = () => reviewHead.value.scrollIntoView({ behavior: "smooth", block: "start" });
</script>

<template>
  <h2>{{ t("Labels") }} <StepPill step="labels" /></h2>
  <p class="hint">{{ t("Each image gets the label its sources agree on: the device’s own reading, a wheel that stayed the same for several readings, an AI model’s answer, and your corrections (yours always win). Only images with two agreeing sources, or your label, are used for training.") }}</p>
  <LabelsCoverageTable @opened="toReview" />
  <LabelsAiServer />
  <h3 ref="reviewHead">{{ t("Review") }}</h3>
  <LabelsReviewPanel />
  <LabelsKeyDrawer />
</template>
