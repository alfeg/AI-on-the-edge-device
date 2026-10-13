# The rate arbiter — how it works now & how to change it

**Living reference.** Describes the *as-built* rate-violation arbiter on branch `feat/llm-arbiter-redesign` and exactly where to change each part. Update this file whenever the arbiter behaviour changes.

> **Why it exists:** to stop a single bad CNN reading from committing a wildly wrong meter value (the ±9000 spikes that poison the Home Assistant energy dashboard) and from poisoning `PreValue` (which would make the meter stick on a wrong value for hours).

---

## 1. What the arbiter is

When post-processing detects that the new reading violates the rate guards (negative rate, or change faster than `MaxRateValue`), and `ArbitrateRateViolations = true`, the firmware sends a **clutter-free strip of just the digit-wheel crops** (the same aligned images the CNN saw — no serial number, barcode, or Qmax/Qmin text) to a vision LLM, asks it for the **digits only (no decimal point)**, and the firmware **places the decimal itself**. The answer is then **re-validated** before it can be trusted. It is a *tie-breaker*, never an oracle.

> **Option B (digit-strip) — implemented.** Earlier the arbiter was sent the full meter face and asked for a number; the model read the right digits but misplaced the decimal 10× (`97768.42` for `9776.84`), so every answer was correctly rejected but useless. Now the firmware stitches the wheel crops (`buildSequenceDigitStrip` in `ClassFlowPostProcessing.cpp`), asks for `N` digits, and reconstructs the value at `Nachkomma` (`parseDigitsFromResponse` in `LLMFallback.cpp`). The decimal-misplacement failure mode is gone by construction.

It runs at three points in `code/components/jomjol_flowcontroll/ClassFlowPostProcessing.cpp::doFlow`:
1. **pre-consistency** (before `checkDigitConsistency`) — when the raw value would violate.
2. **neg-rate branch** — reading below `PreValue` with `AllowNegativeRates = false`.
3. **rate-too-high branch** — change exceeds `MaxRateValue`.

The LLM call itself lives in `code/components/jomjol_llm_fallback/LLMFallback.cpp` (`LLMFallbackArbitrateValue`, `buildArbiterPrompt`).

## 2. Decision flow (per arbiter call)

```
violation detected
  └─ arbiterBudgetAllows(n, now)?            ── no ─► skip → two-witness / self-healing
        └─ yes: lastArbiterCall = now         (budget counts every attempt, incl. timeouts)
           send stitched digit-wheel strip (buildSequenceDigitStrip) + number-free prompt → vision LLM
           parse N digits, firmware places decimal (parseDigitsFromResponse)
           arbiterAnswerAcceptable(answer, liveRaw, PreValue, n)?
              ├─ yes → commit answer (Value = answer; overrides PreValue this cycle)
              └─ no  → log "rejected (implausible or corroborates neither reading)"
                       → fall through to two-witness / self-healing
```

### Key guarantees (the anti-poison logic)
- **`arbiterAnswerAcceptable`** accepts only if the answer is (a) physically plausible (`0 ≤ v ≤ 10^digits/10^decimals`) **and** (b) within ~2% of either the live reading or `PreValue`. A wild value (e.g. `97756.29` when the meter reads `9775`) is rejected, never committed. → `ClassFlowPostProcessing.cpp`, function `arbiterAnswerAcceptable`.
- **The prompt leaks no numbers** (no PreValue/raw/rate), so the model can't echo a candidate. → `LLMFallback.cpp`, `buildArbiterPrompt`.
- If the arbiter is rejected/skipped, the **self-healing re-anchor** (`StuckEscapeCycles`) still bounds any stuck episode. → held branches in `doFlow`, helpers `recordClampSuspect`/`stuckClusterAnchor`.

## 3. Configuration

`[LLMFallback]` (read in `ClassFlowLLMFallback.cpp::ReadParameter` → `LLMConfig`):

| Key | Default | Effect |
|-----|---------|--------|
| `ArbitrateRateViolations` | `false` | Master on/off for the arbiter. |
| `ArbiterModel` | *(empty)* | Model name used for the arbiter (vision). Empty = reuse `Model`. |
| `ArbiterMinIntervalSec` | `0` | Min seconds between arbiter calls per sequence (`0` = unthrottled). **Set to ~600** so a persistent violation can't call every cycle. |
| `TimeoutMs` | `8000`* | Per-call HTTP timeout. Keep small (~20000 max) so a dead endpoint can't stall the cycle. |
| `MaxTokens` | `2048` | Generation budget. High because thinking vision models (qwen3-vl, gemma) reason before answering. |

`[PostProcessing]`:

| Key | Default | Effect |
|-----|---------|--------|
| `StuckEscapeCycles` | `6` | Cycles of agreeing-but-rejected readings before a poisoned `PreValue` is re-anchored. `0` disables. |

\* confirm the compiled default in `LLMFallback.h`.

## 4. Routing (this deployment)

The firmware talks to **LiteLLM** (`Endpoint = http://192.168.68.111:4000/v1`, OpenAI-compatible). Model names resolve there:
- `Model = digit-vl` → small always-on model on the `.111` box → **per-digit fallback**.
- `ArbiterModel = gemma4` → `gemma4:12b` on the workstation `.106` → **arbiter**; LiteLLM **falls back to cloud `qwen3.6`** when `.106` (Ollama) is down. (`gemma4` registered via `/model/new`; fallback set in LiteLLM `config.yaml`.)

So "workstation off" is handled by LiteLLM's fallback; "whole proxy/PC off" is handled by the firmware's two-witness + self-healing.

## 5. Observed behaviour (2026-06-06, new firmware live since 18:36)

- Arbiter consulted on a persistent tiny neg-rate (`raw 9775.62` vs `pre 9775.72`) **every cycle**; qwen3-vl returns `97756.29` (right digits, **decimal misplaced 10×**); `arbiterAnswerAcceptable` **rejected 16/16**. Meter stayed at the true `9775.7x`. **No poison committed.** ✅
- A poisoned `PreValue` (`9786.41`) inherited from `prevalue.ini` across the reboot cleared on the next cycle (startup/age path).

### Known limitations / open work
- **Decimal misplacement — FIXED** by Option B (digit-strip + firmware-owned decimal). The arbiter can now return a value that corroborates the reading and gets accepted, so it actually corrects drifts (e.g. the +1 over-read caused by `checkDigitConsistency` aligning to a poisoned PreValue).
- **Extended-resolution caveat:** reconstruction places the decimal `Nachkomma` from the right (`intLen = numDigits − decimalPlaces`). If `ExtendedResolution` is on, `Nachkomma` is +1 vs the physical wheel split, so the reconstructed value can be 10× off → it'll simply be *rejected* by `arbiterAnswerAcceptable` (safe, not poisoning). This meter runs with `ExtendedResolution = false`, so it's unaffected.
- **`checkDigitConsistency` can mask a poison** — when it rewrites a correct digit *up* to match a wrong PreValue, the reading commits "no error" and never trips a guard, so the self-healing (which only fires on clamped violations) never engages. Mitigation today: disable `[PostProcessing] CheckDigitIncreaseConsistency` (lets the raw flow through → neg-rate → self-healing). Open work: a divergence-based re-anchor that fires when committed value persistently differs from a stable raw cluster even without a rate violation.
- **Fires every cycle on sub-threshold neg-rate** — throttle with `ArbiterMinIntervalSec`; longer-term, run `checkDigitConsistency` *before* the arbiter (deterministic-first, doc 04 §4.1) so transient raw noise never reaches the LLM.

## 6. How to change it (recipes)

| You want to… | Change |
|--------------|--------|
| **Turn it on/off** | `[LLMFallback] ArbitrateRateViolations`. |
| **Throttle calls** | `[LLMFallback] ArbiterMinIntervalSec` (per-sequence cooldown; counts attempts incl. timeouts). |
| **Change which model arbitrates** | `[LLMFallback] ArbiterModel` (must be vision-capable). Routing/fallback is in LiteLLM `config.yaml`. |
| **Loosen/tighten what answers are accepted** | `arbiterAnswerAcceptable` in `ClassFlowPostProcessing.cpp` — the `0.02` (2%) tolerance and the plausibility bound (`maxPlausibleReading`). |
| **Change the prompt** | `buildArbiterPrompt` in `LLMFallback.cpp`. Keep it number-free (no candidate values) to avoid echo. |
| **Change how the digit strip is built** | `buildSequenceDigitStrip` in `ClassFlowPostProcessing.cpp` (gap, background colour, vertical centring, upscale threshold). It stitches `digit_roi` then `analog_roi` crops left-to-right. |
| **Change digit parsing / decimal reconstruction** | `parseDigitsFromResponse` in `LLMFallback.cpp` — digit count tolerance (currently exact, with a dropped-leading-zero pad) and where the decimal is inserted (`numDigits − decimalPlaces`). |
| **Change the arbiter prompt** | `buildArbiterPrompt(numDigits)` in `LLMFallback.cpp` — asks for N digits, no decimal point, no candidate numbers. |
| **Make a stuck PreValue self-heal faster/slower** | `[PostProcessing] StuckEscapeCycles`. |
| **Adjust call sites / ordering** | The three blocks in `doFlow` (pre-consistency, neg-rate, rate-high). To stop over-firing, gate the pre-consistency block behind `checkDigitConsistency` first. |

## 7. Verifying a change (no device unit tests)

1. `cd code && pio run -e esp32cam` (needs `git submodule update --init --recursive` once).
2. Build OTA: `.\tools\build-update-package.ps1` (PowerShell, needs Docker) → upload `build-output\ai-edge-update.zip` at `http://<device>/ota`.
3. Confirm the boot banner commit changed (`/json` + `log/message/`), then watch:
   - `arbiter … rejected (…)` — re-validation firing,
   - `Stuck recovery: PreValue re-anchored …` — self-healing firing,
   - arbiter invocation rate (should fall once `ArbiterMinIntervalSec` is set).
4. For *why* the model reads what it does, enable `[LLMFallback] LogConversations = true` briefly and read the saved JPEG + raw response in `/sdcard/log/llm/` (this is the only thing that shows the image+reply — global DEBUG does not).
