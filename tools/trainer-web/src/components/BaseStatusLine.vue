<!-- The one-line status of a place (see `lines` in stores/app.js). -->
<script setup>
import { lines } from "@/stores/app.js";

defineProps({ where: { type: String, required: true } });
</script>

<template>
  <div class="status" :class="{ bad: lines[where].bad }">{{ lines[where].text }}</div>
</template>
