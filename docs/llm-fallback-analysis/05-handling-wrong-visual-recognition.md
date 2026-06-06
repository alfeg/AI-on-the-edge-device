# 5. Ways to handle wrong visual recognition

A menu of techniques, ordered roughly cheapest/most-robust → most-involved. Each notes whether it's already present, and how it maps to this codebase. The empirical guidance from doc 01: **harmful errors are high-order-digit errors and they are rare; low-order noise is benign and self-corrects.** So the goal is not "perfect OCR" — it's "never let a high-order misread commit or stick".

## 5.1 Temporal redundancy (strongest lever, partly present)

The meter is sampled every 5 min and changes slowly. That redundancy is the single biggest asset.

- **Median-of-N capture.** Capture/recognise 2–3 frames per cycle and take the per-digit median before assembly. Kills transient single-frame misreads. (New; moderate cost — extra inferences, no network.)
- **Two-witness (present).** A violating reading must be corroborated by the next. Keep, but fix the clamp-to-PreValue trap (doc 03 §3.2) so it can re-anchor.
- **Per-digit temporal smoothing.** A high-order digit that's been `0,0,0,0` for a week shouldn't flip to `6` for one frame. Maintain per-ROI recent-mode and require agreement or high confidence to change it. Directly targets the `69780`/`99700` leading-digit errors.

## 5.2 Confidence-aware gating (present, mis-tuned)

- The CNN already exposes `GetOutputValue(class)`; `ConfidenceThreshold` already routes low-confidence digits to the LLM. **Tune per position:** the leading digit being chronically low-confidence (doc 04 §4.6) means the *threshold* is too blunt — a position-aware threshold or sticky cache stops the every-cycle re-query.
- **Reject, don't guess.** For high-order digits below threshold *with no temporal support*, prefer holding/last-good over committing a guess.

## 5.3 Monotonicity & physical bounds (cheap, deterministic — recommend first)

- **Absolute range gate** (doc 03 §3.1): `0 ≤ v ≤ 10^digits − 1`. Blocks `99700`, `1.65`, etc.
- **Monotonic non-decrease** for cumulative meters (with a small tolerance for analog jitter and a configured rollover). The meter only goes *up*; a drop to `209` is physically impossible and should never commit as truth.
- **Max plausible step** from rate history. These are the constraints that should bound *every* override (doc 03 §3.3), including the arbiter's.

## 5.4 Better front-end (reduce errors at the source)

- **Alignment / ROI stability.** Most high-order misreads trace to the digit window drifting (reference-marker alignment). Tightening `ClassFlowAlignment` and ROI definitions removes errors before recognition. Check `log/source/` and `log/align*` images for drift.
- **Lighting / exposure.** Fixed exposure + IR illumination reduces glare-induced flips on reflective dials.
- **Class-balanced / meter-specific model.** See doc 06.

## 5.5 LLM as a *targeted* second opinion (not whole-dial OCR)

From doc 04: the LLM is good at one big digit, bad at whole dials.

- **Single-digit crop verification** for the disputed high-order digit (reuses the per-digit fallback path).
- **Forced-choice adjudication** between deterministic candidates (raw / PreValue / consistency-output / extrapolation) — the model picks `A`/`B`/`N`, never emits the number.
- **Echo detection:** if the model returns exactly a number it was given, treat as low-information.

## 5.6 Ensemble / cross-check

- **Two models vote** (e.g. the standard `dig-class100` + an alternate) and disagreement on a high-order digit triggers the targeted LLM check. Higher flash/RAM cost; only if §5.1–5.3 prove insufficient.
- **Analog/digit cross-validation** where both ROIs exist — the analog sub-dial constrains the rolling digit.

## 5.7 Recovery & observability (limit blast radius)

- **Self-healing re-anchor** (doc 03 §3.2): bound any stuck episode to N cycles.
- **Flat-line + raw-divergence alarm** (doc 03 §3.5): surface "stuck" within minutes; every episode in the dataset is trivially detectable from the existing `Raw`/`Value` columns.
- **Quarantine bucket:** when a reading is rejected, save its full-frame JPEG (the arbiter path already does this to `log/llm/`) so episodes can be replayed and the model retrained.

## 5.8 Recommended layering for this device

1. **Deterministic gates first** (§5.3) — absolute range + monotonic + max-step. Cheap, would have caught every observed failure.
2. **Temporal** (§5.1) — per-digit smoothing + median-of-N for the high-order digits.
3. **Self-healing + alarm** (§5.7) — cap stuck episodes, make them visible.
4. **Targeted LLM** (§5.5) — only for a surviving high-order ambiguity, re-validated.
5. **Model/front-end** (§5.4, doc 06) — longer-term error-rate reduction.

The LLM is the *last* and narrowest layer, not the first. Most of the value comes from layers 1–3, which are deterministic, network-free, and upstream-friendly.
