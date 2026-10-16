<!-- Training and validation loss per epoch, log scale, drawn on a canvas in the page's colours. -->
<script setup>
import { onMounted, ref, watch } from "vue";
import { t } from "../../i18n.js";
import { HINT } from "../../hints.js";
import { train } from "../../app/training.js";
import { LOC } from "../../app/format.js";

const canvas = ref(null);

function draw() {
  const c = canvas.value, h = train.history;
  if (!c) return;
  const dpr = window.devicePixelRatio || 1, W = c.clientWidth || 900, H = c.clientHeight || 130;
  if (c.width !== Math.round(W * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
  const ctx = c.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const css = getComputedStyle(document.documentElement);
  const tok = (n) => css.getPropertyValue(n).trim();
  ctx.clearRect(0, 0, W, H);
  if (!h.length) return;
  // log scale: the loss falls by orders of magnitude in the first epochs, and what matters
  // later (validation loss turning up while training loss still falls) is near the bottom
  const vals = h.flatMap((e) => [e.loss, e.valLoss]).filter((v) => v > 0);
  let lo = Math.log10(Math.min(...vals)), hi = Math.log10(Math.max(...vals));
  if (hi - lo < 0.5) { const m = (hi + lo) / 2; lo = m - 0.25; hi = m + 0.25; }
  const L = 46;
  const x = (i) => L + (i / Math.max(1, train.chartEpochs - 1)) * (W - L - 10);
  const y = (v) => H - 10 - ((Math.log10(Math.max(v, 1e-9)) - lo) / (hi - lo)) * (H - 20);
  ctx.lineWidth = 1; ctx.font = `11px ${tok("--font-mono")}`; ctx.textBaseline = "middle";
  // grid lines at 1, 2, 5 per power of ten; the 2 and 5 lines only when the range is short
  const steps = hi - lo < 2.5 ? [1, 2, 5] : [1];
  for (let k = Math.floor(lo); k <= Math.ceil(hi); k++) {
    for (const m of steps) {
      const v = m * 10 ** k, lv = Math.log10(v);
      if (lv < lo - 1e-9 || lv > hi + 1e-9) continue;
      const yy = Math.round(y(v)) + 0.5;
      ctx.strokeStyle = tok("--color-rule"); ctx.globalAlpha = m === 1 ? 1 : 0.45;
      ctx.beginPath(); ctx.moveTo(L, yy); ctx.lineTo(W - 10, yy); ctx.stroke(); ctx.globalAlpha = 1;
      ctx.fillStyle = tok("--color-muted"); ctx.fillText(v.toLocaleString(LOC, { maximumFractionDigits: 6 }), 2, yy);
    }
  }
  for (const [key, color] of [["loss", "--color-accent"], ["valLoss", "--color-warn"]]) {
    ctx.strokeStyle = tok(color); ctx.lineWidth = 2; ctx.lineJoin = "round"; ctx.beginPath();
    h.forEach((e, i) => (i ? ctx.lineTo(x(i), y(e[key])) : ctx.moveTo(x(i), y(e[key])))); ctx.stroke();
  }
}

watch(() => [train.history.length, train.history], draw);
onMounted(draw);
</script>

<template>
  <canvas id="chart" ref="canvas" width="900" height="130" :aria-label="t('Loss per epoch')"></canvas>
  <div class="legend">
    <span :data-hint="HINT.trainLoss" tabindex="0"><i class="lg-train"></i>{{ t("training loss") }}</span>
    <span :data-hint="HINT.valLoss" tabindex="0"><i class="lg-val"></i>{{ t("validation loss") }}</span>
  </div>
</template>
