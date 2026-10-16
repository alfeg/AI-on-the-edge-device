<!-- A hairline progress bar; value 0..1. -->
<script setup>
defineProps({ value: { type: Number, default: 0 } });
</script>

<template>
  <div class="bar"><i :style="{ transform: `scaleX(${Math.max(0, Math.min(1, value)).toFixed(3)})` }"></i></div>
</template>
