<!-- Usable images per wheel and label, the readiness verdict, and a preview of the images
     behind a number (on hover or focus); clicking a number reviews exactly those images. -->
<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { t } from "../../i18n.js";
import { HINT } from "../../hints.js";
import { LABELS } from "../../labels.js";
import { MIN_PER_DIGIT } from "../../readiness.js";
import { app } from "../../app/state.js";
import { cov, data, cellCrops } from "../../app/project.js";
import { openCell } from "../../app/review.js";
import HintTh from "../common/HintTh.vue";
import CropImg from "../common/CropImg.vue";

const emit = defineEmits(["opened"]);

/** Cells of one wheel's row: usable, to review, then one per label. */
function cells(g) {
  return [
    { l: "*usable", n: g.usable, cls: "" },
    { l: "*review", n: g.review, cls: "" },
    ...LABELS.map((l, i) => {
      const n = g.labels[l], need = i < 10 || g.rolling;
      return { l, n, cls: !need ? "" : n === 0 ? "lo" : n < 15 ? "mid" : "" };
    }),
  ];
}

const verdict = computed(() => {
  const c = cov.value;
  if (!c.rois.length) return "";
  if (c.verdict === "ready") return t("Enough data: every digit has at least {min} usable images over {days} days.", { min: MIN_PER_DIGIT, days: c.days });
  if (c.verdict !== "not-enough") return "";
  return t("Not enough yet") + (c.days < 2 ? t(" (only {n} day of images)", { n: c.days }) : "") + ". " +
    t("Missing: {list}", { list: c.missing.slice(0, 8).join(", ") }) + (c.missing.length > 8 ? t(" and {n} more", { n: c.missing.length - 8 }) : "") + ". " +
    t("Collect more days, or label images in the review below. You can still train, with weaker results.");
});

function open(roi, l) {
  hidePop();
  openCell(roi, l);
  emit("opened");
}

// ---------------------------------------------------------------- preview popover
const POP_N = 12;
const pop = ref(null);          // { el, roi, l, total, crops } while shown
const popEl = ref(null), popPos = ref({ left: "0px", top: "0px" });
let timer = 0;

/** n crops spread evenly over the list (oldest to newest). */
function spreadPick(list, n) {
  if (list.length <= n) return list;
  const out = [], step = list.length / n;
  for (let i = 0; i < n; i++) out.push(list[Math.floor(i * step + step / 2)]);
  return out;
}
function hidePop() { clearTimeout(timer); timer = 0; pop.value = null; }
async function showPop(el, roi, l) {
  if (pop.value?.el === el) return;
  if (!el.isConnected || !el.offsetParent) { hidePop(); return; } // redrawn or hidden meanwhile
  const list = cellCrops(roi, l).sort((a, b) => (a.ts < b.ts ? -1 : 1));
  pop.value = { el, roi, l, total: list.length, crops: spreadPick(list, POP_N) };
  await nextTick();
  // place it under the table (or above it), lined up with the cell, so it never covers
  // the other numbers; the popover itself ignores the pointer (see .pop in the CSS)
  const box = popEl.value; if (!box) return;
  const r = el.getBoundingClientRect(), tableBox = el.closest("table").getBoundingClientRect();
  const w = box.offsetWidth, h = box.offsetHeight;
  let y = tableBox.bottom + 8;
  if (y + h > innerHeight - 8 && tableBox.top - h - 8 > 8) y = tableBox.top - h - 8;
  const x = Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2));
  popPos.value = { left: `${x}px`, top: `${Math.max(8, Math.min(y, innerHeight - h - 8))}px` };
}
function enter(e, roi, l) {
  clearTimeout(timer);
  const el = e.currentTarget;
  timer = setTimeout(() => showPop(el, roi, l), pop.value ? 60 : 120);
}
function leave() { clearTimeout(timer); timer = setTimeout(hidePop, 200); }

const popTitle = computed(() => {
  const p = pop.value; if (!p) return "";
  const what = p.l === "*usable" ? t("usable") : p.l === "*review" ? t("to review") : t("labelled {l}", { l: p.l });
  return `${p.roi} · ${what} · ${t(p.total === 1 ? "{n} image" : "{n} images", { n: p.total })}${p.total > POP_N ? t(", {n} shown", { n: POP_N }) : ""}`;
});
const day = (ts) => `${ts.slice(6, 8)}.${ts.slice(4, 6)}`, time = (ts) => `${ts.slice(9, 11)}:${ts.slice(11, 13)}`;

watch([cov, () => app.step], hidePop); // its cell is about to be replaced or hidden
onMounted(() => addEventListener("scroll", hidePop, { passive: true }));
onBeforeUnmount(() => removeEventListener("scroll", hidePop));
</script>

<template>
  <div id="coverage" class="tw">
    <p v-if="!cov.rois.length" class="hint">{{ t("No images yet. Collect them in step 2.") }}</p>
    <template v-else>
      <table>
        <thead><tr>
          <HintTh :label="t('Wheel')" :hint="HINT.wheel" /><HintTh :label="t('Images')" :hint="HINT.images" /><HintTh :label="t('Days')" :hint="HINT.days" />
          <HintTh :label="t('Usable')" :hint="HINT.usable" /><HintTh :label="t('To review')" :hint="HINT.toReview" />
          <HintTh v-for="l in LABELS" :key="l" :label="t(l)" :hint="HINT.digit(l)" />
        </tr></thead>
        <tbody>
          <tr v-for="g in cov.rois" :key="g.roi">
            <td>{{ g.roi }}{{ g.rolling ? " ↻" : "" }}</td><td>{{ g.crops }}</td><td>{{ g.days }}</td>
            <template v-for="c in cells(g)" :key="c.l">
              <td v-if="c.n" class="cov" :class="c.cls" tabindex="0"
                @mouseenter="enter($event, g.roi, c.l)" @mouseleave="leave" @focus="showPop($event.currentTarget, g.roi, c.l)" @blur="hidePop"
                @click="open(g.roi, c.l)" @keydown.enter.prevent="open(g.roi, c.l)">{{ c.n }}</td>
              <td v-else :class="c.cls">{{ c.n }}</td>
            </template>
          </tr>
        </tbody>
      </table>
      <p class="hint">{{ t("Usable images per label (your labels and confirmed ones). Point at a number to see examples; click it to review exactly those images. ↻ = a rolling wheel that often stops between two digits, so its in-between positions are needed too.") }}</p>
    </template>
  </div>
  <div id="verdict" class="status">{{ verdict }}</div>

  <Teleport to="body">
    <div v-if="pop" id="covPop" ref="popEl" class="pop" role="tooltip" :style="popPos">
      <div class="ph">{{ popTitle }}</div>
      <div class="pg">
        <figure v-for="c in pop.crops" :key="c.id">
          <CropImg :id="c.id" />
          <figcaption v-if="pop.l.startsWith('*')"><b>{{ data.eff.get(c.id)?.label ?? "?" }}</b>{{ day(c.ts) }} {{ time(c.ts) }}</figcaption>
          <figcaption v-else>{{ day(c.ts) }}<br>{{ time(c.ts) }}</figcaption>
        </figure>
      </div>
      <div class="pf">{{ t("Click the number to review them.") }}</div>
    </div>
  </Teleport>
</template>
