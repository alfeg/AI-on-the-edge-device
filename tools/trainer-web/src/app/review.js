// Step 3: reviewing labels, by filters or guided (one wheel + label group at a time).
import { computed, markRaw, reactive, watch } from "vue";
import * as store from "../store.js";
import { LABELS } from "../labels.js";
import { t } from "../i18n.js";
import { app, say } from "./state.js";
import { data, rev, loads, applyLabels, setLabelFields, usableSt, reviewSt } from "./project.js";

export const REV_PAGE = 96; // tiles per "Show more" when not guided

export const review = reactive({
  guided: true,
  roi: "", label: "", show: "review",   // filters (guided review sets roi + label itself)
  groupKey: null,                       // guided: "roi|label" of the open group
  list: [],                             // crops shown, fixed until the next reset
  shown: REV_PAGE,
  sel: -1,                              // index of the selected crop in list
  drawer: false,                        // label keys drawer open
  tPending: false,                      // "T" pressed: the next digit means "between"
});

function matchesShow(show, e) {
  if (show === "usable") return usableSt(e.status);
  if (show === "unapproved") return e.status !== "human" && e.status !== "excluded" && !!e.label;
  if (show === "review") return reviewSt(e.status);
  if (show === "conflict") return e.status === "conflict";
  if (show === "human") return e.status === "human" || e.status === "excluded";
  return true;
}
function reviewList(useFilters = true) {
  const roi = useFilters ? review.roi : "", lab = useFilters ? review.label : "";
  return data.crops.filter((c) => {
    if (roi && c.roi !== roi) return false;
    const e = data.eff.get(c.id);
    if (lab && e.label !== lab) return false;
    return matchesShow(review.show, e);
  }).sort((a, b) => data.eff.get(a.id).score - data.eff.get(b.id).score || (a.ts < b.ts ? 1 : -1));
}

// ---- guided review: groups in wheel order, then label order
const labelOrder = (l) => { const i = LABELS.indexOf(l); return i < 0 ? 99 : i; };
function cmpGroups(a, b) {
  const [ra, la] = a.split("|"), [rb, lb] = b.split("|");
  return ra.localeCompare(rb, undefined, { numeric: true }) || labelOrder(la) - labelOrder(lb);
}
function reviewGroups() {
  const m = new Map();
  for (const c of reviewList(false)) {
    const k = `${c.roi}|${data.eff.get(c.id)?.label ?? "?"}`;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(c);
  }
  return { keys: [...m.keys()].sort(cmpGroups), m };
}
/** In the open group: does this crop still need a look? */
function stillOpen(c) {
  const e = data.eff.get(c.id);
  if (review.show === "review") return reviewSt(e.status);
  if (review.show === "conflict") return e.status === "conflict";
  return !data.labels.get(c.id)?.human;
}
function setGroup(key) {
  review.groupKey = key;
  const [roi, lab] = key ? key.split("|") : ["", ""];
  review.roi = roi; review.label = lab === "?" ? "" : lab;
}

/** Fills the list again from the filters (or the guided group); clears the selection. */
export function resetReview() {
  if (review.guided) {
    const { keys, m } = reviewGroups();
    if (!review.groupKey || !m.has(review.groupKey)) setGroup(keys.find((k) => !review.groupKey || k > review.groupKey) ?? keys[0] ?? null);
    review.list = markRaw(review.groupKey ? [...m.get(review.groupKey)].sort((a, b) => (a.ts < b.ts ? -1 : 1)) : []);
  } else review.list = markRaw(reviewList());
  review.shown = review.guided ? review.list.length : REV_PAGE;
  review.sel = -1; review.drawer = false;
}
watch(loads, resetReview);

/** Move to the group dir (+1 / -1) steps from the open one, among groups with images. */
export function gotoGroup(dir) {
  const { keys } = reviewGroups();
  let next = null;
  if (!keys.length) next = null;
  else if (!review.groupKey) next = keys[0];
  else if (dir > 0) next = keys.find((k) => cmpGroups(k, review.groupKey) > 0) ?? keys[0];
  else next = [...keys].reverse().find((k) => cmpGroups(k, review.groupKey) < 0) ?? keys.at(-1);
  setGroup(next); resetReview();
}

/** What the guided review's bar shows. */
export const groupInfo = computed(() => {
  rev.value; // recount when labels change
  if (!review.guided) return null;
  const { keys } = reviewGroups();
  const [roi, label] = (review.groupKey || "|").split("|");
  return {
    roi, label, groups: keys.length,
    pos: review.groupKey ? keys.indexOf(review.groupKey) : -1,
    left: review.list.filter(stillOpen).length,
  };
});

/** "Approve all": every crop in the group that still needs a look keeps its shown label as yours. */
export async function acceptRest() {
  const todo = review.list.filter((c) => stillOpen(c) && data.eff.get(c.id)?.label);
  if (!todo.length) return;
  const recs = todo.map((c) => ({ ...(data.labels.get(c.id) || { id: c.id }), human: data.eff.get(c.id).label }));
  await store.putLabels(recs);
  applyLabels(recs);
  const [roi, l] = review.groupKey.split("|");
  say("rev", t("Approved {n} images of {roi} as {l}.", { n: todo.length, roi, l }));
  gotoGroup(+1);
}

export function select(k) {
  review.sel = k; review.tPending = false; review.drawer = true;
  if (k >= review.shown) review.shown = Math.ceil((k + 1) / REV_PAGE) * REV_PAGE;
}

/** Your label for a crop: a label, "x" (unusable) or null (remove yours). */
export async function setHuman(c, l) {
  await setLabelFields(c, { human: l });
  if (review.guided && l !== null && !review.list.some(stillOpen)) {
    say("rev", t("{group} done.", { group: review.groupKey.replace("|", " · ") }));
    setTimeout(() => gotoGroup(+1), 500);
  }
}

// ---- filter changes
export function filterChanged() {
  if (review.guided) {
    const { keys } = reviewGroups();
    setGroup(keys.find((k) => { const [r, l] = k.split("|"); return (!review.roi || r === review.roi) && (!review.label || l === review.label); }) ?? null);
  }
  resetReview();
}
export function showChanged() { review.groupKey = null; resetReview(); }
export function guidedChanged() {
  review.groupKey = null;
  if (!review.guided) { review.roi = ""; review.label = ""; }
  resetReview();
}
/** Review exactly the crops behind a coverage cell ("*usable", "*review" or a label). */
export function openCell(roi, l) {
  review.roi = roi;
  review.label = l.startsWith("*") ? "" : l;
  review.show = l === "*review" ? "review" : "usable";
  filterChanged(); // in guided review: jump to that wheel and label's group, not the next one
}

// ---- keyboard labelling
export function onReviewKey(e) {
  if (app.step !== "labels" || /INPUT|SELECT|TEXTAREA/.test(e.target.tagName) || e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key;
  if (review.guided) {
    if (k === "]" || k === "PageDown") { e.preventDefault(); gotoGroup(+1); return; }
    if (k === "[" || k === "PageUp") { e.preventDefault(); gotoGroup(-1); return; }
    if (k === "a" || k === "A") { e.preventDefault(); if (canAccept()) acceptRest(); return; }
  }
  if (!review.drawer) return;
  const c = review.list[review.sel];
  const step = (d) => select(Math.max(0, Math.min(review.list.length - 1, review.sel + d)));
  const next = () => setTimeout(() => step(+1), 80);
  if (k === "ArrowRight" || k === "ArrowDown") { e.preventDefault(); step(+1); return; }
  if (k === "ArrowLeft" || k === "ArrowUp") { e.preventDefault(); step(-1); return; }
  if (!c) return;
  if (k === "Escape") { review.drawer = false; return; }
  if (k === "t" || k === "T") { review.tPending = true; return; }
  if (/^[0-9]$/.test(k)) { e.preventDefault(); const l = review.tPending ? `${k}/${(+k + 1) % 10}` : k; review.tPending = false; setHuman(c, l).then(next); return; }
  if (k === "x" || k === "X") { setHuman(c, "x").then(next); return; }
  if (k === "Enter") { const lab = data.eff.get(c.id).label; if (lab) setHuman(c, lab).then(next); return; }
  if (k === "Backspace") { e.preventDefault(); setHuman(c, null); }
}
export const canAccept = () => {
  const g = groupInfo.value;
  return !!g && !!g.left && !!g.label && g.label !== "?";
};
