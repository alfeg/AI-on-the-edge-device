<!-- One image in the review grid: the crop, its label and where the label came from. -->
<script setup>
import { statusHint } from "@/i18n/hints.js";
import { sourcesText } from "@/utils/format.js";
import BaseCropImage from "@/components/BaseCropImage.vue";

defineProps({
  crop: { type: Object, required: true },
  eff: { type: Object, required: true },     // effective label: { label, status, sources }
  selected: { type: Boolean, default: false },
});
</script>

<template>
  <button type="button" class="tile" :class="`st-${eff.status}`" :data-hint="statusHint[eff.status] || ''" :aria-selected="selected ? 'true' : 'false'">
    <BaseCropImage :id="crop.id" lazy />
    <span class="l">{{ eff.status === "excluded" ? "x" : (eff.label ?? "?") }}</span>
    <span class="s">{{ crop.roi }} · {{ sourcesText(eff.sources) }}</span>
  </button>
</template>
