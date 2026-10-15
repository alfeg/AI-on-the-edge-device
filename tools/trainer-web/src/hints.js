// Short explanations shown when pointing at (or focusing) a status word, a table heading or
// a setting. Any element with data-hint="..." gets the shared tooltip from initHints().
import { MIN_PER_DIGIT, MIN_PER_TRANSITION } from "./readiness.js";

export const MIN_COMPARE = 100; // test images the device read itself, needed to compare models

/** Hint for a step's status word (the pill next to the title and in the step bar). */
export function pillHint(id, text) {
  if (!text || text === "–") return "";
  const t = text.toLowerCase();
  switch (id) {
    case "autoPill":
      return "Where each step stands. Click a step to open it.";
    case "setupPill":
      return {
        checking: "Reading the device’s configuration…",
        ready: "The device saves its digit images and keeps them long enough to train on.",
        check: "Training works, but a setting below needs a look, for example images that are deleted after a few days.",
        "action needed": "The device does not save digit images yet. Fix the red item below first.",
        "not on a device": "This page was not opened from a meter, so it cannot collect images or install a model. Importing a dataset and training still work.",
      }[t] || "";
    case "collectPill":
      return t === "empty" ? "No images in this browser yet: check for new images, then download them."
        : "Digit images stored in this browser so far. They stay here after a reload.";
    case "labelsPill":
      return {
        "ready to train": `Every digit 0–9 has at least ${MIN_PER_DIGIT} usable images, rolling wheels have ${MIN_PER_TRANSITION} of each in-between position, and the images span 2 or more days.`,
        "not enough yet": `Some digits have fewer than ${MIN_PER_DIGIT} usable images (or in-between positions fewer than ${MIN_PER_TRANSITION}), or all images come from one day. You can still train, but the model will be weaker on what is missing. The line under the table lists it.`,
      }[t] || "";
    case "trainPill":
      return {
        "new model ready": "On the same test images, the new model reads at least as well as the model installed now.",
        "not better": "On the same test images, the new model reads worse than the installed one. Installing it would make readings worse: label or collect more, then train again.",
        "not compared": `Fewer than ${MIN_COMPARE} test images were read by the device itself, so the two models cannot be compared fairly. Collect more days.`,
      }[t] || "";
    case "installPill":
      if (t === "no model yet") return "Train a model in step 4 first.";
      if (t === "installed") return "The device now reads with the new model. If readings get worse, go back to the previous model below.";
      return "The last trained model. It is kept in this browser until you train another.";
  }
  return "";
}

/** Hints for words that are fixed in the page or in generated tables. */
export const HINT = {
  // train chart
  trainLoss: "How wrong the model is on the images it learns from. It should keep falling.",
  valLoss: "How wrong it is on images held back from learning. If it rises while training loss keeps falling, the model is memorising; the page keeps the epoch where this was lowest.",
  // coverage table (Labels)
  wheel: "One digit position on the meter, named as in the device’s configuration. ↻ marks a rolling wheel that often stops between two digits.",
  images: "Images of this wheel stored in this browser.",
  days: "How many different days these images come from. More days means more kinds of light.",
  usable: "Images training uses: labelled by you, or two sources agree (for example the device and the AI).",
  toReview: "Images with only one source, or whose sources disagree. Not used for training until you check them.",
  digit: (l) => (l.includes("/") ? `Usable images where the wheel stands between ${l.replace("/", " and ")}.` : `Usable images labelled ${l}.`),
  // collect plan table
  toDownload: "Images chosen for download, spread evenly over the days.",
  skipped: "Images left on the device: their reading already has enough images here.",
  readingsFull: "Readings (wheel + what the device read) that reach “images per reading” after this download.",
  readingsShort: "Readings that still have fewer than “images per reading”, even after this download. More days would help.",
  // compare table (Train)
  testImages: "Images from the newest days, held back from training, with a usable label.",
  newModel: "Share of the test images the new model reads correctly.",
  deviceNow: "Share the installed model got right on the test images it read itself (its reading is in the file name).",
  between: "Test images where the wheel stands between two digits.",
  newModelBetween: "Share of those the new model reads as either of the two digits.",
  // settings
  daysBack: "How many days of the device’s image folders to look at.",
  perReading: "Images kept per wheel and device reading (for example dig3 reading 7). A wheel at rest shows the same digit for days, so most of its images are not needed.",
  modelSize: "Bigger models can be a little more accurate but take longer to read each digit on the device.",
  epochs: "How many times training goes through all images. The page keeps the epoch with the lowest validation loss, so more is safe, only slower.",
  batch: "Images per training step. Larger is faster on a GPU; the default suits most cases.",
  lr: "How big each learning step is. Too high and training jumps around; too low and it is slow.",
  llmN: "How many images to send to the AI server this time. They are spread over all wheels and readings.",
  show: "Needs review: one source, or sources disagree. Disagreements: the device and the AI read different digits. Not approved by you: everything you have not labelled yourself. Usable: what training uses. Labelled by you: your own labels.",
};

/** Hint for an image tile in the review grid, by label status. */
export const statusHint = {
  human: "Labelled by you. Used for training.",
  confirmed: "Two sources agree. Used for training.",
  unconfirmed: "Only one source. Not used for training until you approve it.",
  conflict: "The sources disagree. Pick the right digit.",
  excluded: "Marked unusable by you. Left out of training.",
  none: "No label yet.",
};

/** One shared tooltip for every [data-hint] element: on hover, on keyboard focus, and on tap. */
export function initHints() {
  const tip = document.createElement("div");
  tip.className = "tip"; tip.id = "hintTip"; tip.setAttribute("role", "tooltip"); tip.hidden = true;
  document.body.append(tip);
  let cur = null, timer = 0;
  const place = (el) => {
    const r = el.getBoundingClientRect(), w = tip.offsetWidth, h = tip.offsetHeight, m = 8;
    const left = Math.max(m, Math.min(window.innerWidth - w - m, r.left));
    const top = r.bottom + m + h > window.innerHeight ? r.top - h - m : r.bottom + m;
    tip.style.left = `${left}px`; tip.style.top = `${Math.max(m, top)}px`;
  };
  const show = (el) => {
    const text = el.dataset.hint; if (!text) return;
    cur = el; tip.textContent = text; tip.hidden = false; place(el);
    el.setAttribute("aria-describedby", "hintTip");
  };
  const hide = () => { clearTimeout(timer); if (cur) cur.removeAttribute("aria-describedby"); cur = null; tip.hidden = true; };
  document.addEventListener("pointerover", (e) => {
    const el = e.target.closest?.("[data-hint]");
    if (el === cur) return;
    hide();
    if (el && el.dataset.hint) timer = setTimeout(() => show(el), e.pointerType === "mouse" ? 350 : 0);
  });
  document.addEventListener("pointerleave", hide);
  document.addEventListener("focusin", (e) => { const el = e.target.closest?.("[data-hint]"); hide(); if (el) show(el); });
  document.addEventListener("focusout", hide);
  window.addEventListener("scroll", hide, { passive: true, capture: true });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") hide(); });
}
