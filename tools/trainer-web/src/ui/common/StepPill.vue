<!-- A step's status word, next to its title. The hint explains it (hints.js). -->
<script setup>
import { computed } from "vue";
import { pills, pillId, pillText, pillTip } from "../../app/state.js";

const props = defineProps({ step: { type: String, required: true } });
const hint = computed(() => pillTip(props.step));
</script>

<template>
  <span :id="pillId(step)" class="pill" :class="pills[step].kind" :data-hint="hint" :tabindex="hint ? 0 : -1">{{ pillText(step) }}</span>
</template>
