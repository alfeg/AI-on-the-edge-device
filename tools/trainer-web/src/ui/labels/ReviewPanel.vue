<!-- Review: filters or guided groups, the image grid, and keyboard labelling (app/review.js). -->
<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { t, tHtml, N_ } from "../../i18n.js";
import { HINT } from "../../hints.js";
import { LABELS } from "../../labels.js";
import { app } from "../../app/state.js";
import { cov, data, rev } from "../../app/project.js";
import { review, REV_PAGE, groupInfo, canAccept, acceptRest, gotoGroup, select, filterChanged, showChanged, guidedChanged, onReviewKey } from "../../app/review.js";
import { exportCsv, exportZip } from "../../app/exporting.js";
import StatusLine from "../common/StatusLine.vue";
import ReviewTile from "./ReviewTile.vue";

const SHOW = [["review", N_("Needs review")], ["conflict", N_("Disagreements")], ["unapproved", N_("Not approved by you")], ["usable", N_("Usable")], ["human", N_("Labelled by you")], ["all", N_("All")]];
const rois = computed(() => cov.value.rois.map((r) => r.roi));
const shown = computed(() => review.list.slice(0, review.shown));
/** Effective label of a crop; reading rev re-renders the grid when labels change. */
const effFor = (c) => (rev.value, data.eff.get(c.id));

/** The guided bar's text: the open group ({ roi, label, rest }) or a message ({ msg }). */
const groupLine = computed(() => {
  const g = groupInfo.value;
  if (!g) return { msg: "" };
  if (!review.groupKey) return { msg: g.groups ? "" : t("Nothing left to review here.") };
  return { roi: g.roi, label: g.label, rest: ` · ${t("{i} of {n} still to check", { i: g.left, n: review.list.length })} · ${t("group {i} of {n}", { i: g.pos >= 0 ? g.pos + 1 : "–", n: g.groups })}${g.pos < 0 ? t(" (done)") : ""}` };
});
const acceptText = computed(() => {
  const g = groupInfo.value;
  return g?.label && g.label !== "?" ? t("Approve all as {l} ({n})", { l: g.label, n: g.left }) : t("Approve all");
});

// keep the selected tile in view
const grid = ref(null);
watch(() => review.sel, (k) => nextTick(() => grid.value?.querySelector(`[data-k="${k}"]`)?.scrollIntoView({ block: "nearest" })));

onMounted(() => document.addEventListener("keydown", onReviewKey));
onBeforeUnmount(() => document.removeEventListener("keydown", onReviewKey));
</script>

<template>
  <div class="row opts"><label class="c"><input id="revGuided" v-model="review.guided" type="checkbox" @change="guidedChanged"> {{ t("One wheel and label at a time (groups with nothing to check are skipped)") }}</label></div>
  <div v-if="review.guided" id="revGroupBar" class="groupbar">
    <button type="button" :disabled="!groupInfo?.groups" @click="gotoGroup(-1)">{{ t("← Previous group") }}</button>
    <span v-if="'msg' in groupLine">{{ groupLine.msg }}</span>
    <span v-else><b>{{ groupLine.roi }}</b> · {{ t("shown as") }} <b>{{ groupLine.label }}</b>{{ groupLine.rest }}</span>
    <button id="revAccept" class="primary" type="button" :disabled="!canAccept()" @click="acceptRest">{{ acceptText }}</button>
    <button type="button" :disabled="!groupInfo?.groups" @click="gotoGroup(+1)">{{ t("Next group →") }}</button>
  </div>
  <StatusLine id="revStatusLine" where="rev" />

  <div class="row">
    <label class="f" for="revRoi">{{ t("Wheel") }}
      <select id="revRoi" v-model="review.roi" @change="filterChanged"><option value="">{{ t("All") }}</option><option v-for="r in rois" :key="r">{{ r }}</option></select>
    </label>
    <label class="f" for="revLabel">{{ t("Label") }}
      <select id="revLabel" v-model="review.label" @change="filterChanged"><option value="">{{ t("Any") }}</option><option v-for="l in LABELS" :key="l">{{ l }}</option></select>
    </label>
    <label class="f" for="revStatus" :data-hint="HINT.show">{{ t("Show") }}
      <select id="revStatus" v-model="review.show" @change="showChanged"><option v-for="[v, name] in SHOW" :key="v" :value="v">{{ t(name) }}</option></select>
    </label>
  </div>
  <p class="hint" v-html="tHtml('reviewKeys', 'Click an image, then: <b>0–9</b> digit · <b>T</b> then a digit for between two digits (T 6 = 6/7) · <b>X</b> unusable · <b>Backspace</b> remove your label · <b>← →</b> move · <b>Enter</b> accept the shown label. Group by group: fix the wrong ones, then <b>A</b> approves all the others as shown and moves on · <b>[ ]</b> previous / next group.')"></p>

  <div id="revGrid" ref="grid" class="grid" role="listbox" :aria-label="t('Images to review')">
    <p v-if="!review.list.length" class="hint">{{ t("Nothing to show here.") }}</p>
    <ReviewTile v-for="(c, k) in shown" :key="c.id" :data-k="k" :crop="c" :eff="effFor(c)" :selected="k === review.sel" @click="select(k)" />
  </div>
  <div class="row"><button v-if="review.shown < review.list.length" id="revMore" @click="review.shown += REV_PAGE">{{ t("Show more ({n} left)", { n: review.list.length - review.shown }) }}</button></div>
  <div class="more">
    <button class="link" type="button" :disabled="!!app.busy" @click="exportZip('rev')">{{ t("Export dataset (zip with images)") }}</button>
    <button class="link" type="button" :disabled="!!app.busy" @click="exportCsv('rev')">{{ t("Export labels (CSV)") }}</button>
  </div>
</template>
