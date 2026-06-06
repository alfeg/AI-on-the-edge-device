# 2. Root-cause code analysis

This traces, line by line, how a *correct* CNN reading becomes a committed garbage value, and why the arbiter can't stop it. All references are to `code/components/jomjol_flowcontroll/ClassFlowPostProcessing.cpp` (the `doFlow` loop) and the LLM modules unless noted.

## 2.1 The post-processing pipeline for one number sequence

Per cycle, for each `NUMBERS[j]`, `doFlow` does (simplified):

```
1.  assemble ReturnRawValue from per-ROI results          (CNN/LLM digit results)
2.  Value = stod(ReturnValue)                              (line ~876)
3.  EARLY ARBITER  — if Value would violate rate, ask LLM  (lines 890–939)
4.  checkDigitConsistency(Value, …, PreValue)              (lines 941–953)
5.  ChangeRateThreshold dead-band snap to PreValue         (lines 960–968)
6.  NEG-RATE guard  (+ arbiter + two-witness)              (lines 978–1067)
7.  MAX-RATE guard  (+ arbiter + two-witness)              (lines 1078–1169)
8.  commit: PreValue = Value; write data log               (lines 1184–1199)
```

There are **two independent transforms that can rewrite `Value`** before the rate guards even run (steps 3 and 4), and the rate guards themselves *clamp* rather than *quarantine* (steps 6–7). Each is a poisoning vector.

## 2.2 Poisoning vector A — `checkDigitConsistency` (step 4)

`checkDigitConsistency(input, decimalshift, isanalog, preValue)` (lines 1322–1377) walks digit positions from the decimal point upward and, for each high-order digit, **overwrites the current reading's digit with `PreValue`'s digit** unless it detects a legitimate rollover ("nulldurchgang"):

```cpp
no_nulldurchgang = (olddigit_before <= aktdigit_before);
if (no_nulldurchgang) {
    if (aktdigit != olddigit)
        input += (olddigit - aktdigit) * pow(10, pot);   // force digit back to PreValue's
} else {
    if (aktdigit == olddigit)
        input += 1 * pow(10, pot);                        // force a carry
}
```

This is sound **only when `input` and `PreValue` are already within one digit of each other** — its whole premise (stated in the code comment at line 882) is "the CNN flipped at most one digit". When that premise is false the function produces arbitrary results, and **its output is not bounded or sanity-checked** before becoming `Value`.

Failure modes this creates:

- If `PreValue` is *already poisoned* (e.g. `1.65`), this function actively drags a correct reading (`9725.16`) toward the poison, manufacturing the slow creep `1.65 → 1.92 → 2.59…` seen in the logs.
- If the LLM per-digit fallback corrected *several* ROIs in one cycle (a legitimate large jump), the single-flip assumption breaks and a real jump is squashed. This is acknowledged in the code (the early arbiter at step 3 was added specifically to paper over it).

## 2.3 Poisoning vector B — the rate guards "clamp" instead of "quarantine" (steps 6–7)

When a reading violates the neg-rate or max-rate guard and is **not** confirmed by a witness/arbiter, the code does:

```cpp
NUMBERS[j]->suspectValue = NUMBERS[j]->Value;   // remember the suspect
NUMBERS[j]->Value        = NUMBERS[j]->PreValue; // ← report PreValue instead
NUMBERS[j]->ReturnValue  = "";
…
WriteDataLog(j);
continue;                                        // skip the commit/PreValue update
```

This is the **two-witness** mechanism: a violating reading is held; if the *next* reading corroborates it (within tolerance), the suspect is promoted and overrides `PreValue`. That is reasonable in principle, but it has a fatal interaction:

- While held, the reported `Value` is forced to `PreValue`. If `PreValue` is the poisoned one, the device keeps **reporting the poison** for as long as the real reading keeps "disagreeing" with it — which is forever, because the real reading is correct and the poison is wrong. The two-witness logic only re-anchors if **two consecutive real readings** match each other within `MaxRateValue×1.5` *and* the held-suspect logic fires; in practice (see doc 01) episodes lasted hours.

The deeper problem: **the guard treats `PreValue` as ground truth.** Once `PreValue` is wrong, every defense built on "compare to PreValue" inverts — it rejects the truth and protects the lie.

## 2.4 How the *first* poison commits ("no error" on a −9723 change)

The seed rows (doc 01 §1.1) are logged `no error` with `chg = −9723`. For a huge negative change to commit cleanly, one of these held at the moment of seeding:

- `AllowNegativeRates = true` **or** `useMaxRateValue = false` for that cycle, so neither guard was armed; **or**
- the **early arbiter accepted** a bogus value (step 3 commits `Value = arbValue` and sets `earlyArbiterAccepted`, which then *skips* both rate guards — lines 934, 975); **or**
- `checkDigitConsistency` produced the small number from a multi-digit CNN/LLM error and `PreValue` at that instant was itself mid-transition.

The early arbiter is the most dangerous of these because, as doc 01 shows, the arbiter **echoes the number in its prompt**. If at seed time `currentRaw` was a small misread, the arbiter can parrot it back and the code commits it with `earlyArbiterAccepted = true`, bypassing every downstream guard.

## 2.5 Why the arbiter over-fires (step 3 placement)

The early arbiter (lines 890–939) runs **before** `checkDigitConsistency`, on the raw assembled value, whenever it *would* be a neg-rate or rate-high:

```cpp
bool earlyArbiterAccepted = false;
if (PreValueUse && PreValueOkay && LLMFallbackArbiterEnabled() && rawImage) {
    bool wouldBeNegRate  = !AllowNegativeRates && Value < PreValue;
    bool wouldBeRateHigh = useMaxRateValue && |rate| > MaxRateValue;
    if (wouldBeNegRate || wouldBeRateHigh) {
        … writeToMemoryAsJPG(75); LLMFallbackArbitrateValue(…);   // network call
    }
}
```

Consequences:

1. **It fires before the cheap local fix.** `checkDigitConsistency` would have repaired most single-digit high-order flips for free; instead they hit a multi-second vision-LLM call first.
2. **It has no rate-limit, cooldown, or budget.** A stuck meter (PreValue poisoned) violates *every* cycle → one arbiter call every cycle, indefinitely (the 314-in-3-days figure).
3. **`writeToMemoryAsJPG(75)` + base64 + HTTP+TLS every cycle** is exactly the heap-heavy path the architecture warns about, now run needlessly hundreds of times.

## 2.6 Why the arbiter can't keep big errors out

`LLMFallbackArbitrateValue` (in `LLMFallback.cpp`) and `buildArbiterPrompt` (lines 299–318):

- The prompt **states `PreValue` and `currentRaw` as exact numbers** and asks the model to "reply with the actual current meter value". A vision model that cannot resolve the dial defaults to repeating a number it was given → it returns `PreValue` (confirmed in transcript). So the arbiter's output is **strongly biased toward the very value we're trying to validate**.
- On the caller side, a parsed result is **accepted unconditionally**:

  ```cpp
  bool ok = LLMFallbackArbitrateValue(…, &arbValue, …);
  if (ok) {
      NUMBERS[j]->Value = arbValue;          // ← no bound check on arbValue
      … hasSuspectReading = false;
      witnessOverrideThisCycle = true;       // ← disables remaining guards
  }
  ```

  There is **no check** that `arbValue` is itself plausible (≥ `PreValue` for a non-negative meter, within `MaxRateValue×elapsed`, same digit count, etc.). A hallucinated arbiter number commits directly and poisons `PreValue`.

## 2.7 Per-digit fallback over-firing (`ClassFlowCNNGeneral.cpp`)

Lines 738–757: every digit ROI whose confidence `< ConfidenceThreshold` (or hard-fail) is queued; after TFLite is freed, each queued ROI is sent to the LLM (lines 913–963). On this device the leading "9" digit is *chronically* low-confidence, so it is sent **every cycle** and the LLM dutifully returns `9` (125 times on 06-06). This is wasteful (network + latency + SD writes) though not itself a correctness bug. See doc 04 §4.6 and doc 05 §5.2 for de-duplication ideas.

## 2.8 Defect ledger (what to fix → which doc)

| ID | Defect | Severity | Fix doc |
|----|--------|----------|---------|
| D1 | Rate guard clamps to `PreValue`; one bad commit → multi-hour stuck reading | **critical** | 03 §3.1, §3.2 |
| D2 | `PreValue` treated as ground truth; no independent re-anchor / staleness escape | **critical** | 03 §3.2 |
| D3 | Arbiter result committed with no plausibility re-validation | **critical** | 03 §3.3, 04 §4.4 |
| D4 | Arbiter prompt leaks candidate numbers → model echoes them | high | 04 §4.3 |
| D5 | Early arbiter runs before `checkDigitConsistency`, every violating cycle, no budget | high | 04 §4.1, §4.5 |
| D6 | `checkDigitConsistency` output unbounded; misfires on multi-digit changes | high | 03 §3.1 |
| D7 | Arbiter `TimeoutMs=170000` blocks the cycle; no effect on accuracy | medium | 04 §4.5 |
| D8 | Per-digit fallback re-queries the same stable digit every cycle | low | 04 §4.6 |
