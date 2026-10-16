<!-- Table heading with a hint (focusable, so it also works by keyboard and on touch). -->
<script setup>
defineProps({ label: { type: String, required: true }, hint: { type: String, default: "" } });
</script>

<template>
  <th :data-hint="hint" tabindex="0">{{ label }}</th>
</template>
