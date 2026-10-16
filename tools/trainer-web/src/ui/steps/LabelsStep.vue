<!-- Step 3: how many usable labels there are, AI labelling, and the review. -->
<script setup>
import { ref } from "vue";
import { t } from "../../i18n.js";
import StepPill from "../common/StepPill.vue";
import CoverageTable from "../labels/CoverageTable.vue";
import AiServer from "../labels/AiServer.vue";
import ReviewPanel from "../labels/ReviewPanel.vue";
import LabelDrawer from "../labels/LabelDrawer.vue";

const reviewHead = ref(null);
const toReview = () => reviewHead.value.scrollIntoView({ behavior: "smooth", block: "start" });
</script>

<template>
  <h2>{{ t("Labels") }} <StepPill step="labels" /></h2>
  <p class="hint">{{ t("Each image gets the label its sources agree on: the device’s own reading, a wheel that stayed the same for several readings, an AI model’s answer, and your corrections (yours always win). Only images with two agreeing sources, or your label, are used for training.") }}</p>
  <CoverageTable @opened="toReview" />
  <AiServer />
  <h3 ref="reviewHead">{{ t("Review") }}</h3>
  <ReviewPanel />
  <LabelDrawer />
</template>
