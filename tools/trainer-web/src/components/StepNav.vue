<!-- Back / Next at the bottom of a step. -->
<script setup>
import { computed } from "vue";
import { t } from "@/i18n/index.js";
import { STEPS, STEP_NAMES, go } from "@/stores/app.js";

const props = defineProps({ step: { type: String, required: true } });
const i = computed(() => STEPS.indexOf(props.step));
const prev = computed(() => STEPS[i.value - 1]);
const next = computed(() => STEPS[i.value + 1]);
</script>

<template>
  <div class="stepnav">
    <button v-if="prev" type="button" @click="go(prev)">← {{ STEP_NAMES[prev] }}</button><span v-else></span>
    <button v-if="next" type="button" class="primary" @click="go(next)">{{ t("Next: {step} →", { step: STEP_NAMES[next] }) }}</button>
  </div>
</template>
