<!-- The one-line status of a place (see `lines` in app/state.js). -->
<script setup>
import { lines } from "../../app/state.js";

defineProps({ where: { type: String, required: true } });
</script>

<template>
  <div class="status" :class="{ bad: lines[where].bad }">{{ lines[where].text }}</div>
</template>
