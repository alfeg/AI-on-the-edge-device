<!-- A crop's JPEG from browser storage. lazy: loads once it is near the screen. -->
<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { cropUrl } from "../../app/project.js";

const props = defineProps({ id: { type: String, required: true }, lazy: { type: Boolean, default: false } });
const img = ref(null), src = ref("");
let url = null, observer = null;

async function load() {
  const id = props.id, u = await cropUrl(id);
  if (!u) return;
  if (id !== props.id || !img.value) { URL.revokeObjectURL(u); return; } // changed or gone meanwhile
  if (url) URL.revokeObjectURL(url);
  url = u; src.value = u;
}
onMounted(() => {
  if (!props.lazy) { load(); return; }
  observer = new IntersectionObserver(([en]) => { if (en.isIntersecting) { observer.disconnect(); load(); } }, { rootMargin: "400px 0px" });
  observer.observe(img.value);
});
watch(() => props.id, load);
onBeforeUnmount(() => { observer?.disconnect(); if (url) URL.revokeObjectURL(url); });
</script>

<template>
  <img ref="img" :src="src || undefined" alt="">
</template>
