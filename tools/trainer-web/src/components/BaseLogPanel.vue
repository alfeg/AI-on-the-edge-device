<!-- A log with timestamps (device setup, install). Scrolls to the newest line. -->
<script setup>
import { nextTick, ref, watch } from "vue";
import { logs } from "@/stores/app.js";

const props = defineProps({ where: { type: String, required: true } });
const el = ref(null);
watch(() => logs[props.where].map((l) => l.text), () => nextTick(() => { if (el.value) el.value.scrollTop = el.value.scrollHeight; }));
</script>

<template>
  <ol v-show="logs[where].length" ref="el" class="log" aria-live="polite">
    <li v-for="(l, i) in logs[where]" :key="i" :class="{ head: l.head, bad: l.bad }"><time>{{ l.time }}</time><span class="m">{{ l.text }}</span></li>
  </ol>
</template>
