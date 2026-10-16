<!-- The label keys drawer at the bottom: the selected image large, its sources, and a key per label. -->
<script setup>
import { computed } from "vue";
import { t } from "../../i18n.js";
import { LABELS } from "../../labels.js";
import { app } from "../../app/state.js";
import { data, rev } from "../../app/project.js";
import { review, setHuman } from "../../app/review.js";
import { sourcesText } from "../../app/format.js";
import CropImg from "../common/CropImg.vue";

const crop = computed(() => (review.drawer && app.step === "labels" ? review.list[review.sel] : null));
const eff = computed(() => (rev.value, crop.value && data.eff.get(crop.value.id)));
const rec = computed(() => (rev.value, (crop.value && data.labels.get(crop.value.id)) || {}));

const info = computed(() => {
  if (review.tPending) return t("Between two digits: press the lower one (T 6 = 6/7)");
  const c = crop.value, e = eff.value, r = rec.value;
  return t("{roi}  {ts}  label {l} ({src})  device {d}{rej}  AI {ai}", { roi: c.roi, ts: c.ts, l: e.status === "excluded" ? "x" : e.label ?? "?",
    src: sourcesText(e.sources), d: c.pred ?? "–", rej: c.rejected ? t(" rejected") : "", ai: r.llm ?? "–" });
});
/** The key that is lit: your label, else the shown one; "x" when excluded. */
const isOn = (l) => (l === "x" ? eff.value.status === "excluded" : (rec.value.human || (eff.value.status !== "excluded" && eff.value.label)) === l);
</script>

<template>
  <Teleport to="body">
    <div v-if="crop" id="drawer" class="drawer">
      <div class="drawer-in">
        <CropImg :id="crop.id" />
        <div class="drawer-info">
          <div id="selInfo" class="status">{{ info }}</div>
          <div id="keys" class="keys">
            <template v-for="(l, i) in [...LABELS, 'x']" :key="l">
              <span v-if="i === 10 || i === 20" class="sep"></span>
              <button type="button" :class="{ on: isOn(l) }" @click="setHuman(crop, l)">{{ l === "x" ? t("X unusable") : l }}</button>
            </template>
            <button type="button" :disabled="!rec.human" @click="setHuman(crop, null)">{{ t("Remove my label") }}</button>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>
