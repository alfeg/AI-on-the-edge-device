<!-- The new model against the installed one, per wheel, on the newest days' images. -->
<script setup>
import { computed } from "vue";
import { t } from "../../i18n.js";
import { HINT, MIN_COMPARE } from "../../hints.js";
import { train } from "../../app/training.js";
import { pct1 } from "../../app/format.js";
import HintTh from "../common/HintTh.vue";

const pct = (a, n) => (n ? `${pct1(a / n)}%` : "–");
const cls = (a, n) => (!n ? "" : a / n < 0.95 ? "lo" : a / n < 0.99 ? "mid" : "ok");
const note = computed(() => {
  const m = train.model;
  return t("Test images are each wheel’s newest days and were not used for this comparison. “Device now” is what the installed model read on the same images.") +
    (m?.final ? " " + t("The model to install was then trained again on all images, the test images included, so it has seen more than the one scored here.") : "") + " " +
    (m?.devAcc != null ? t("On the {n} test images the device read itself: new {a}%, installed {b}%. Where the label came from the device, the installed model’s score is flattered.", { n: m.compareN, a: pct1(m.accOnDev), b: pct1(m.devAcc) })
      : t("Only {n} test images were read by the device ({min} needed), so the two models are not compared; collect more days.", { n: m?.compareN ?? 0, min: MIN_COMPARE }));
});
</script>

<template>
  <div id="evalTable" class="tw">
    <template v-if="train.compare">
      <table>
        <thead><tr>
          <HintTh :label="t('Wheel')" :hint="HINT.wheel" /><HintTh :label="t('Test images')" :hint="HINT.testImages" />
          <HintTh :label="t('New model')" :hint="HINT.newModel" /><HintTh :label="t('Device now')" :hint="HINT.deviceNow" />
          <HintTh :label="t('Between digits')" :hint="HINT.between" /><HintTh :label="t('New model')" :hint="HINT.newModelBetween" />
        </tr></thead>
        <tbody>
          <tr v-for="e in train.compare" :key="e.roi">
            <td>{{ e.roi }}</td><td>{{ e.n }}</td><td :class="cls(e.model, e.n)">{{ pct(e.model, e.n) }}</td>
            <td :class="cls(e.dev, e.devN)">{{ pct(e.dev, e.devN) }}</td><td>{{ e.t }}</td><td>{{ pct(e.tModel, e.t) }}</td>
          </tr>
        </tbody>
      </table>
      <p class="hint">{{ note }}</p>
    </template>
  </div>
</template>
