# LLM fallback & rate-arbiter — failure analysis and redesign

**Branch:** `feat/llm-fallback`
**Date:** 2026-06-06
**Data analysed:** 30 days of `data_*.csv` (2026-05-08 → 06-06, 8 297 readings), 3 days of full `message/` logs (06-04/05/06), and `llm/` transcripts from a live device at `192.168.68.115` (meter "main", a 5-integer-digit + 2-decimal rolling gas meter reading ≈ 09774.xx, published on MQTT topic `gasmeter`).

This folder documents why the device "sometimes reports very low values that don't match the meter", why the LLM rate-arbiter "executes far more often than expected" and "fails to keep big errors out", and proposes a redesign. Code-change proposals are written to be **isolated** so they rebase cleanly onto upstream.

---

## TL;DR — what's actually happening

1. **The root failure is PreValue poisoning, not the CNN.** A single bad reading gets committed and becomes the new `PreValue`. From then on every *correct* reading looks like a rate violation, gets clamped back to the poisoned `PreValue`, and the meter is **stuck reporting the wrong value for hours** until something coincidentally re-anchors it. The CNN raw value is frequently *correct* during these episodes (e.g. raw `09725.16` was committed as `1.65`).

2. **The arbiter fires every cycle because the meter is stuck, not because errors are frequent.** While poisoned, *every* 5-minute cycle violates the rate guard → the arbiter is invoked every cycle (314 invocations in 3 days, one per reading). The high call count is a *symptom* of poisoning.

3. **The arbiter accepted 0 readings in 3 days — but the model itself is fine.** Two *fixable, non-model* reasons:
   - It **times out because the arbiter model (`qwen3-vl`) runs on a work PC that isn't always on**, and `TimeoutMs = 170000` (170 s) lets each such call block the whole 5-minute cycle. (A cloud fallback for when the PC is off was deliberately deferred until the call *rate* is fixed — point 2.)
   - When it *does* answer it often **echoes a number we put in the prompt** (35 % returned `PreValue` verbatim). This is a **prompt** problem, verified live: the same class of local vision model reads the dial *correctly* (`09700.26`) with a clean digit-by-digit prompt, but returns a leaked number (`9708.02`) with the current prompt. Even forced-choice anchors it. → fix the prompt, don't blame the model.

4. **The arbiter's answer is committed with no re-validation.** Even structurally, a parsed arbiter value overrides `PreValue` immediately without re-checking it against the rate window — so a hallucinated number would commit directly.

5. **The per-digit fallback also over-fires** (1 224 calls in 3 days; 125× just to re-confirm the same hard "9" digit). Wasteful, not harmful.

---

## Implemented on branch `feat/llm-arbiter-redesign`

The following changes from docs 03–04 are now in the firmware (all behaviour-preserving when the new knobs are left at defaults that match legacy, except the prompt change which is strictly an improvement):

| Change | Files | Effect |
|--------|-------|--------|
| **Arbiter answer re-validation** — a parsed arbiter value is committed only if it is physically plausible **and** corroborates either the live reading or PreValue (within ~2%); otherwise it's rejected and logged. | `ClassFlowPostProcessing.cpp` (`arbiterAnswerAcceptable`), all 3 arbiter sites | Stops a hallucinated/echoed value (e.g. `1.65` when the meter reads `9725`) from poisoning PreValue. |
| **De-leaked arbiter prompt** — no candidate numbers (PreValue/raw/rate) are put in the prompt anymore. | `LLMFallback.cpp` (`buildArbiterPrompt`) | Removes the echo failure mode at the source (the model must read the dial, not parrot a number). |
| **Self-healing re-anchor** — after `StuckEscapeCycles` consecutive clamped cycles whose rejected readings agree with each other, PreValue is re-anchored to them. | `ClassFlowPostProcessing.cpp` (neg-rate + rate-high held branches), `ClassFlowDefineTypes.h` | Bounds a stuck/poisoned episode to ~N cycles instead of hours. |
| **Arbiter call budget** — `ArbiterMinIntervalSec` throttles arbiter calls per sequence; the timer counts attempts (incl. timeouts). | `LLMFallback.*`, `ClassFlowLLMFallback.cpp`, `ClassFlowPostProcessing.cpp` | A stuck meter / dead endpoint can no longer trigger an arbiter call every cycle. |

New config keys (full web-UI round-trip + param-docs added): `[PostProcessing] StuckEscapeCycles` (default `6`) and `[LLMFallback] ArbiterMinIntervalSec` (default `0` = unthrottled). The deterministic-first reorder (doc 04 §4.1) and the cloud fallback (§4.8) are **not** implemented yet — the self-healing + budget already collapse the call rate, which was the prerequisite the operator set for the cloud work.

## Documents

| # | File | Question it answers |
|---|------|--------------------|
| 1 | [01-empirical-failure-analysis.md](01-empirical-failure-analysis.md) | What do the logs actually show? Quantified failure episodes. |
| 2 | [02-root-cause-code-analysis.md](02-root-cause-code-analysis.md) | Where in the code does a correct reading become garbage? |
| 3 | [03-proposal-preventing-bad-values.md](03-proposal-preventing-bad-values.md) | How do we make sure the system stops committing/▸getting stuck on wrong low values? (isolated changes) |
| 4 | [04-arbiter-redesign.md](04-arbiter-redesign.md) | Why does the arbiter over-fire and fail; what should it be fed (history? estimates?); when should it run. |
| 5 | [05-handling-wrong-visual-recognition.md](05-handling-wrong-visual-recognition.md) | The full menu of techniques to handle wrong visual recognition. |
| 6 | [06-training-own-model.md](06-training-own-model.md) | Do the digit logs hold enough data to train our own model? |

A companion Claude Code skill — [`.claude/skills/llm-fallback/SKILL.md`](../../.claude/skills/llm-fallback/SKILL.md) — captures the data-flow map and the gotchas so future work on this code is faster and safer.

## Reproducing the analysis

The raw logs were pulled with a recursive crawl of the device's `/fileserver/log/` endpoint and analysed with `device-logs/analyze.py` (not committed — lives outside the repo tree). See doc 01 for the exact queries.
