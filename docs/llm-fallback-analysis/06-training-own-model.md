# 6. Do the digit logs hold enough data to train our own model?

**Short answer:** Enough to *fine-tune / specialise* the existing digit CNN to **this** meter — yes, with caveats. Enough to train a *general* digit model from scratch — no. And the labels need cleaning first, because they are the current model's own (sometimes wrong) predictions, not ground truth.

## 6.1 What the digit log actually contains

`/sdcard/log/digit/<YYYYMMDD>/<HH>/<label>_<seq>_dig<N>_<timestamp>.jpg`

- The **filename prefix is the label** — but it is `result_klasse`, i.e. the **CNN's own prediction at log time** (written in the per-ROI loop *before* the deferred LLM fallback corrects anything; `ClassFlowCNNGeneral.cpp` ~line 730). So the labels embed the CNN's mistakes.
- Each crop is a single digit ROI, already aligned and sized the way the model expects — ideal raw material for the project's existing training pipeline.
- **Retention ≈ 15 days.** The full pull held 15 day-folders (`20260523–20260606`), **25 371 digit crops**. The log still rotates, so a training set must be **harvested periodically** (every ~2 weeks captures everything), but the standing corpus is substantial — not the ~3 days an early partial sample suggested.
- The companion **`source/` folder holds 4 145 full-frame meter images (~115 MB)** — useful for retraining alignment and for the arbiter's whole-dial path.

## 6.2 Volume and class balance (full 15-day pull, 25 371 crops)

Per-class counts (digit positions 1–7 combined):

| class | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 (N/blank) |
|------:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| count | 4387 | **542** | 1502 | 2265 | 1862 | 1321 | 1256 | **5031** | **626** | **5292** | 1287 |

≈ **1 700 crops/day**; the standing 15-day corpus is ~25 k. **Every class has ≥ 500 samples** — enough to *train* on, though still imbalanced ~10:1 between `9`/`7` (≈5 000) and `1`/`8` (≈550).

**The skew is instructive:** the meter sits around `0977x.xx`, so the high-order positions are dominated by `0,9,7` while the low digits cycle through everything. Classes `1` and `8` are the starved ones and would need oversampling/augmentation or a longer harvest.

## 6.3 Implications

**Against training a general model:**
- Single meter, single font, single fixed camera/lighting → no visual diversity.
- Extreme class imbalance (20:1 between `7` and `1`); rare classes are starved.
- Labels are self-generated → training on them **distills the current model including its high-order-digit errors** (the exact failures in doc 01 §1.5). A model trained on its own mistakes learns the mistakes.

**For fine-tuning to *this* meter (worthwhile):**
- The hard cases here are specific and repeatable (the leading `0`↔`6`/`9` confusion, the `1`↔`4` confusion in position 4). A small specialised head trained on **cleaned** crops of *this* meter could remove exactly those.
- The crops are pipeline-ready; no preprocessing needed.

## 6.4 What it would take to make the data usable

1. **Clean the labels** (mandatory). Options, best first:
   - **Temporal consensus:** for each digit position, the true digit is stable across consecutive cycles. Auto-relabel using the per-position mode over a window; flag disagreements for review. The slow meter makes this very reliable.
   - **Cross-label with the value log:** the committed (post-rate-guard) value gives the digit string for clean cycles; use those as labels and discard violation cycles.
   - **LLM/manual relabel** of only the uncertain crops (the ones currently routed to the fallback).
2. **Rebalance:** oversample/augment rare classes (`1`,`3`,`8`,`10`) or harvest for several weeks; better, **merge with the public jomjol training set** so global classes stay represented and you only *add* this meter's hard cases.
3. **Hold out by time** (train on weeks 1–3, validate on week 4) so you measure generalisation, not memorisation of a near-constant reading.
4. Use the project's existing CNN training tooling (the community `dig-class100` / `Make-Model` workflow) rather than a bespoke trainer.

## 6.5 Recommendation

- **Don't** train a from-scratch model on this log alone.
- **Do** stand up a **periodic harvest** (the crops rotate off the SD in ~15 days, so pull at least every 2 weeks) into a labelled corpus, auto-labelled by temporal consensus, **merged with the public dataset**, and use it to fine-tune the digit model to kill this meter's specific high-order confusions.
- **Bigger win first:** per doc 01, even a perfect CNN wouldn't have prevented the observed failures — they were *post-processing* poisoning of *correct* readings. Fix docs 03–04 before investing in model training. Model work reduces the *rate* of the high-order errors that feed the guards; the guard/recovery fixes stop those errors from becoming multi-hour outages.
