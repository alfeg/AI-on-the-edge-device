# 4. Arbiter redesign

This answers the explicit questions: *why does the arbiter run so often, what should it be fed (more than one value? estimates?), and how do we make it actually keep big errors out.*

## 4.0.0 The immediate priority: cut the call rate (it's the blocker for the cloud fallback)

The operator's stated next step is a **cloud-model fallback** for when the local qwen3-vl PC is off — but that was (correctly) **deferred until the arbiter stops firing every cycle**. Spraying a paid cloud vision API once per 5-minute cycle, forever, while the meter is stuck, would be expensive and pointless. So the ordering is:

1. **Make the arbiter fire rarely** (§4.1) — deterministic repair first, fix the stuck state upstream (doc 03 §3.2), add a budget/cooldown.
2. **Make each call trustworthy** (§4.3 prompt, §4.4 re-validation).
3. *Then* the cloud fallback is safe and cheap: a handful of calls per month, each one re-validated. See §4.9.

Everything below serves step 1 first.

## 4.0 Reframe: what is the arbiter *for*?

Today the arbiter is asked an impossible question — "read this whole gas-meter dial to 1/100 from a 25 KB JPEG" — which `qwen3-vl` cannot do, so it echoes a number from the prompt (doc 01 §1.3). A vision LLM is good at **disambiguating a single uncertain digit** and **sanity-judging** ("is this dial roughly at X or at 10X?"), and bad at **precise multi-digit OCR**. The redesign plays to that.

Two distinct jobs, currently conflated into one bad call:

- **J1 — digit disambiguation:** "which digit is in *this* crop?" → already done well by the per-digit fallback. Keep.
- **J2 — gross-error adjudication:** "the assembled value jumped from 9774 to 9709 / to 1.65 — which magnitude is right?" → this is the arbiter's real job, and it should be a *coarse* yes/no/which-of-N decision, not free-form OCR.

## 4.1 Why it over-fires, and the fix

**Cause (doc 02 §2.5):** the early arbiter runs *before* `checkDigitConsistency`, on every cycle that violates the rate guard, with no rate-limit. A stuck meter violates every cycle → one call per cycle forever (314 in 3 days).

**Fixes (each isolated, additive):**

1. **Run deterministic repair first, escalate only the residual.** Move `checkDigitConsistency` (and the §3.1 plausibility gate) ahead of the arbiter; call the arbiter *only* if a violation survives them. Most single high-order-digit flips never reach the LLM.
2. **Fix the stuck state (doc 03 §3.2).** Once the meter can self-heal, the "violate every cycle" condition disappears and arbiter volume collapses to the genuine-error rate (a handful per month, per doc 01).
3. **Add an explicit budget/cooldown** (new `[LLMFallback]` keys, all default-off so upstream is unaffected):
   - `ArbiterMinIntervalSec` — minimum seconds between arbiter calls per number (e.g. 600). Within the interval, fall back to two-witness only.
   - `ArbiterMaxPerDay` — hard daily cap per number (e.g. 24). Log when the cap is hit (no silent drop).
   - `ArbiterCooldownAfterAcceptSec` — after a successful re-anchor, suppress further arbiter calls briefly to let the new `PreValue` settle.

```cpp
// gate, evaluated before the existing arbiter block
bool arbiterAllowed =
    LLMFallbackArbiterEnabled()
    && (now - n->lastArbiterCall   >= ArbiterMinIntervalSec)
    && (n->arbiterCallsToday        <  ArbiterMaxPerDay);
```

## 4.2 What to feed the arbiter — *yes, more than one value, but not naively*

The user's instinct ("give it the value log, give it estimates") is right, with one critical caveat from the data: **the model copies numbers out of the prompt.** So extra numeric context must be supplied as *constraints that make the wrong answer impossible to express*, not as more numbers to parrot.

Useful context the firmware already has and can supply:

| Signal | Where it lives | How the arbiter should use it |
|--------|----------------|------------------------------|
| **Recent accepted history** (last K values + timestamps) | `prevalue.ini` is single-value, but `data_*.csv` has it; keep a small in-RAM ring | Compute an **expected range** `[PreValue, PreValue + maxStep]` and tell the model *only the range*, asking which bound the dial is near |
| **Expected next value / rate estimate** | `FlowRateAct` history → linear extrapolation | Provide an *estimate* and ask "closer to A or B?" (forced choice, see §4.3) |
| **Per-digit CNN confidences** | `tflite->GetOutputValue()` per ROI (already computed) | Only send the *uncertain* digit crops; tell the model the high-confidence digits as fixed context |
| **Which ROI is suspect** | the queue in `ClassFlowCNNGeneral` | Crop the image to the disputed digit(s) — a vision model reads one big digit far better than a whole dial |
| **DecimalShift / digit count** | `NumberPost` | Constrain the answer format so echoes are detectable |

### Estimates: yes — but as a *prior*, not the answer

Supplying the expected value lets you (a) build a forced-choice prompt and (b) **detect the echo**: if the model returns *exactly* the estimate or *exactly* `PreValue`, treat the response as low-information and fall back to witnesses. (Today it returns exactly `PreValue` and we trust it — the opposite of correct.)

## 4.3 A prompt that the model can't game

**The single most important rule, verified live (doc 01 §1.3.1): put *no numbers* in the prompt.** Every number you include becomes a candidate the model may parrot. With the current prompt a local vision model returned a leaked number (`9708.02`); with a clean digit-by-digit prompt the *same model* read the dial correctly (`09700.26`). Even **forced-choice anchored** the model to a listed value. So the ranking below leads with the no-number options.

**(a) Cold digit read** (recommended — what worked in the probe):

> This is a gas-meter odometer. Read the digits left to right; the black digits are whole units and the red digit is the decimal. Reply with ONLY the digits, no spaces.

No candidate numbers → nothing to echo. The firmware parses the digit string and feeds it through re-validation (§4.4). The high-order digits — the ones that matter — came back correct and deterministic in testing.

**(b) Single-digit crop verification** (most accurate for the high-order errors that actually hurt):

> Reply with the single digit (0–9) shown in this image, or `N` if you can't tell.

Send a crop of the *one* disputed high-order digit (doc 01 §1.5 shows errors are almost always high-order) — **and tell it nothing about what the digit "should" be** (that's just another number to anchor on). This reuses the per-digit fallback path (J1) — i.e. **the arbiter problem largely reduces to running the existing digit fallback on the high-order digit when the assembled value is implausible.** That is a much smaller, well-understood, echo-proof call.

## 4.4 Always re-validate (doc 03 §3.3)  *(implemented)*

Whatever the arbiter returns, run it through `arbiterAnswerAcceptable()`: it must be physically plausible **and corroborate the live reading or PreValue** (within ~2%). Note it is *not* re-checked against the rate window — doing so would reject legitimate un-poisoning (the arbiter's whole purpose is to override a suspect PreValue). If it fails, discard and fall back to two-witness / self-healing. The arbiter becomes *a witness with a fast vote*, never an oracle.

## 4.5 Latency / timeout

- `TimeoutMs = 170000` means a single arbiter call can stall the whole 5-minute pipeline for ~3 minutes (and they still time out). Drop to **~20000**. A vision call that can't answer in 20 s isn't useful for a 5-minute cadence anyway.
- The single-digit-crop prompt (§4.3b) returns a 1-token answer, so `MaxTokens` can drop to ~16 and latency falls sharply.
- Keep the arbiter on the *deferred* path (after TFLite is freed) — it already is.
- **Add a fast "endpoint down" path.** The real-world timeouts are the local PC being off. A short pre-flight (e.g. a 1–2 s TCP/health probe, or a small first `TimeoutMs`) lets the arbiter skip to two-witness immediately instead of stalling the cycle for 170 s. This is also the natural hook for the cloud fallback (§4.9).

## 4.6 Per-digit fallback de-duplication (D8)

The leading "9" digit is re-queried every cycle (125×/day) and always returns `9`. Cheap mitigations:

- **Sticky-digit cache:** if a given ROI returned the same LLM digit on the previous N cycles *and* the CNN's top class is unchanged, skip the call and reuse the cached digit.
- **Raise the per-ROI call only when the assembled value is in doubt:** if the CNN value already passes the plausibility + rate gates, a single low-confidence interior digit rarely matters — defer the LLM call.

## 4.7 Target call volume

| | Now (3 days) | After redesign (projected) |
|---|---|---|
| Arbiter calls | 314 (≈1/cycle) | single digits/month (genuine gross errors only) |
| Arbiter accepts | 0 | ~all of the few it makes |
| Per-digit calls | 1 224 | ~10–20× fewer with sticky cache |
| Stuck episodes | multi-hour | ≤ `StuckEscapeCycles` |

## 4.7.1 Local arbiter models — measured

Replaying saved full-frame arbiter JPEGs (meter truly at `09700.xx`) against local Ollama vision models with the de-leaked prompt:

| Model | Reads integer part (`09700`) | Notes | Speed |
|-------|------------------------------|-------|-------|
| **gemma4:12b** | **12/12 (100%)** | Vision is fine **once `"think": false` is set** (it's a reasoning model; otherwise it spends the whole token budget thinking and returns empty `content`). Only the *decimal placement / trailing digits* are wrong (`097000.26`), so the raw answer still fails the 2% corroboration check. | ~0.8 s |
| **granite3.2-vision** | poor | Misperceives — sometimes reads the meter's printed **serial number** (`203030`), drops digits, inconsistent count. | ~0.8 s |

Takeaways:
- **Don't cap tokens for thinking models.** The old `MaxTokens=200` default truncates a reasoning model before it answers (qwen3-vl used 535 completion tokens for one number). Default raised to `2048`; Ollama additionally gets `"think": false`.
- **gemma4:12b is a viable *local* arbiter** for the high-order magnitude — but only after two fixes: send a **tight ROI crop** (not the full meter face with serial/label/glare), and either give a **format hint** (N integer + M decimal digits) or reconstruct the value from the digit string using `Nachkomma`. Its 100% integer-read rate on a hard full-frame image is promising.
- This is why the firmware **re-validates** (§4.4): gemma's mis-formatted `097000.26` and granite's `203030` both fail corroboration and are safely discarded — a weak local arbiter degrades to "no opinion", never to a poisoned commit.

## 4.8 The cloud fallback (now safe to add)

Once §4.1 (rate) + §4.4 (re-validation) are in, the deferred cloud fallback becomes cheap and low-risk:

- **Tier the providers:** primary = local qwen3-vl (free, when the PC is on); fallback = a cloud vision model only when the local endpoint fails the fast health probe (§4.5). A second `[LLMFallback]` provider block (or `ArbiterFallbackEndpoint`/`ArbiterFallbackModel`/`ArbiterFallbackApiKey`) keeps it isolated and default-empty.
- **Cost is bounded by the budget (§4.1):** with deterministic-first + self-healing + `ArbiterMaxPerDay`, the cloud is hit only for the genuine gross errors — single digits per month, not per cycle. Without the rate fix, the cloud fallback would bill for the every-cycle storm — exactly why deferring it was the right call.
- **Re-validation (§4.4) applies equally to the cloud answer.** A bigger model still must clear the plausibility + rate window before it can touch `PreValue`. No provider is an oracle.
- Use the same **no-numbers** prompt (§4.3) regardless of provider — the echo failure is provider-independent (reproduced on a local 2.5 B model).

## 4.9 Summary

The arbiter doesn't need *more raw numbers* — it needs (1) to fire far less (deterministic-first + budget + self-healing upstream), (2) a prompt it can't game (forced-choice or single-digit crop), (3) mandatory re-validation of its answer, and (4) a sane timeout. Feeding it history/estimates is valuable specifically as a way to build the constrained prompt and to **detect echoes**, not as extra free-form context.
