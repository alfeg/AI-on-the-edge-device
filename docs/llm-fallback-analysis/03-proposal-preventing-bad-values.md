# 3. Proposal — stop the system reporting/▸sticking on wrong values

Goal: make a *single* bad reading unable to (a) commit as truth, or (b) trap the device in a multi-hour stuck state. The design principle is a one-line inversion of the current behaviour:

> **`PreValue` is a hypothesis, not ground truth. A reading that persistently disagrees with `PreValue` is evidence that `PreValue` is wrong — not that the reading is.**

Everything below is structured as **isolated, individually-revertable changes**, each behind a config flag or a self-contained helper, so the branch rebases cleanly onto upstream and any single fix can be dropped.

## 3.1 Fix D6/D1 — bound every transform, never commit an implausible absolute value

Add one pure helper (no dependencies, easy to upstream) and call it at exactly one place — right before commit.

```cpp
// ClassFlowPostProcessing.cpp — new static helper, no member state
// Returns true if `v` is a physically plausible reading for this number sequence.
static bool isPlausibleReading(double v, const NumberPost* n) {
    if (v < 0) return false;                              // meters don't go negative
    double maxAbs = pow(10, n->digitCount) - 1;           // e.g. 99999.99 for 5+2
    if (v > maxAbs) return false;                         // out-of-range (leading-digit insert)
    return true;
}
```

Then **gate the commit** (around line 1184, just before `PreValue = Value`):

```cpp
if (!isPlausibleReading(NUMBERS[j]->Value, NUMBERS[j])) {
    NUMBERS[j]->ErrorMessageText += "Implausible value rejected ";
    NUMBERS[j]->Value = NUMBERS[j]->PreValue;   // report last good, do NOT poison PreValue
    WriteDataLog(j);
    continue;                                   // PreValue/prevalue.ini untouched
}
```

> **Correction (validated against the data):** an absolute-range gate alone is *weak* here — `1.65`, `209`, even `99700` are all inside `[0, 99999.99]`, so a range check does **not** catch them. The seeds were huge *jumps*, not out-of-range values. The range check is still worth keeping as cheap defense-in-depth (it catches negatives and overflow), but the real seed-prevention is §3.3 below: the arbiter answer (and any override) must **corroborate the live reading or PreValue**, never invent a third magnitude. `1.65` corroborates neither `9725` (raw) nor `9725` (pre) → rejected.

> **Why isolated:** one new file-static function. *(Implemented as `isPlausibleReading`/`maxPlausibleReading` in `ClassFlowPostProcessing.cpp`.)*

## 3.2 Fix D1/D2 — make clamp-to-PreValue *self-healing* (anti-stuck escape hatch)

The two-witness logic already remembers a suspect. The bug is that it only re-anchors when two *consecutive* readings match within tolerance, which a slowly-changing meter rarely satisfies after poisoning. Add a **persistence / staleness escape**: if the device has been clamping to the same `PreValue` while a *stable cluster* of disagreeing readings accumulates, re-anchor to that cluster.

Concretely, extend the existing suspect machinery (no new global state beyond a small ring buffer per number):

```cpp
// when a reading is held (neg-rate or rate-high, not witnessed):
NUMBERS[j]->suspectHistory.push(Value);          // small fixed ring, e.g. last 5
NUMBERS[j]->consecutiveClampCount++;

// re-anchor condition (checked in the held branch):
if (NUMBERS[j]->consecutiveClampCount >= StuckEscapeCycles      // e.g. 3
    && suspectCluster_isStable(suspectHistory, tol)             // readings agree w/ each other
    && isPlausibleReading(clusterMedian, NUMBERS[j])) {
    LogFile.WriteToFile(ESP_LOG_WARN, TAG, name +
        ": PreValue looks poisoned; re-anchoring " +
        RundeOutput(PreValue,…) + " -> " + RundeOutput(clusterMedian,…));
    NUMBERS[j]->Value = clusterMedian;
    NUMBERS[j]->PreValue = clusterMedian;     // ← break out of the stuck state
    NUMBERS[j]->consecutiveClampCount = 0;
    // fall through to commit
}
```

Key point: the re-anchor compares the held readings **to each other**, not to `PreValue`. Three correct readings that agree with each other but disagree with `PreValue` are proof that `PreValue` is the outlier. Reset `consecutiveClampCount` to 0 on any clean (non-violating) commit.

New config knob `[PostProcessing] StuckEscapeCycles` (default e.g. `3`; `0` = disabled = exact current behaviour, so upstream/users who don't set it are unaffected).

> **Why isolated:** reuses the existing `suspectValue`/`hasSuspectReading` fields, adds a counter + tiny ring buffer to `NumberPost`, and one new `if` in each held branch. Defaults to a no-op.

## 3.3 Fix D3 — never let the arbiter (or any override) commit an unchecked value  *(implemented)*

Wrap *every* arbiter override path (early, neg-rate, rate-high) in one acceptance gate so a model answer is a *candidate*, not a command.

**Important design subtlety discovered while implementing:** the gate must **not** re-apply the rate/monotonic check. The arbiter's whole job is to override a *suspect* `PreValue`; re-checking the answer against `PreValue`'s rate window would reject exactly the legitimate un-poisoning we want (e.g. when `PreValue` is poisoned high and the true reading is lower). The right check is **corroboration**: a trustworthy answer is physically plausible *and* lands near either the live reading or `PreValue`, rather than inventing a third magnitude.

```cpp
// implemented in ClassFlowPostProcessing.cpp
static bool arbiterAnswerAcceptable(double cand, double liveRaw, double preValue,
                                    const NumberPost* n) {
    if (!isPlausibleReading(cand, n)) return false;          // bounds / non-negative
    double ref = std::max(fabs(liveRaw), fabs(preValue));
    if (ref < 1.0) ref = 1.0;
    double tol = std::max(ref * 0.02, 5.0);                  // within 2% of raw or pre
    return fabs(cand - liveRaw) <= tol || fabs(cand - preValue) <= tol;
}
```

Each `if (ok) { Value = arbValue; … }` became `if (ok && arbiterAnswerAcceptable(arbValue, liveRaw, PreValue, n)) { … }`, with an `else if (ok)` that logs the rejection. A wild answer like `1.65` (far from both `9725` raw and `9725` pre) is discarded and the code falls through to two-witness / self-healing.

Echo is prevented *upstream* by the de-leaked prompt (doc 04 §4.3): with no candidate numbers in the prompt, the model can't parrot one, so the corroboration check is judging a genuine read.

## 3.4 Fix the seed: don't let the early arbiter bypass guards on a fresh poison

The early arbiter sets `earlyArbiterAccepted = true`, which **skips `checkDigitConsistency` and both rate guards**. With §3.3 in place this is safer, but also reorder so the *cheap, deterministic* repair runs first (see doc 04 §4.1): run `checkDigitConsistency` first; only escalate to the arbiter for the *residual* violation it couldn't fix. That removes the bypass entirely.

## 3.5 Operational safety net (independent of firmware)

These need no code change and protect against the *current* firmware while the above is implemented and flashed:

1. **Alert on flat-line + raw divergence.** A downstream rule ("`Value` unchanged for >N cycles while a `Raw` field is logged and differs by >X") would have flagged every episode in doc 01 within ~15 minutes. The data log already contains `Raw` and `Value` columns side by side.
2. **Bound-check in the consumer** (Home Assistant / MQTT subscriber): reject readings outside `[lastGood, lastGood + maxPlausibleStep]`. The device publishes enough to do this externally today.
3. **Lower `TimeoutMs`** from 170000 to ~20000 (doc 04 §4.5) so a slow arbiter stops blocking cycles.

## 3.6 Priority / sequencing

| Order | Change | Effort | Risk | Payoff |
|-------|--------|--------|------|--------|
| 1 | §3.1 plausibility gate on commit | tiny | very low | blocks 100 % of observed seeds |
| 2 | §3.3 `acceptOverride` gate | tiny | very low | stops arbiter committing garbage |
| 3 | §3.2 self-healing escape | small | low | bounds stuck episodes to N cycles |
| 4 | §3.4 reorder consistency-before-arbiter | small | medium | removes bypass + cuts arbiter calls |

Items 1–2 are a few lines each, default-safe, and would have prevented every failure in the 30-day dataset. They are the recommended first PR.
