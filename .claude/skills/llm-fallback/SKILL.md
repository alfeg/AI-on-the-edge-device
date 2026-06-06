---
name: llm-fallback
description: Work safely on the LLM digit fallback, the rate-violation arbiter, and the post-processing rate guards (PreValue / two-witness / checkDigitConsistency). Use this skill whenever the task touches digit recognition correctness, "meter reports wrong/low/stuck values", the `[LLMFallback]` config, the arbiter, or the neg-rate / max-rate / two-witness logic in ClassFlowPostProcessing.
---

# LLM fallback & rate-arbiter — working map

This pipeline turns CNN digit predictions into a committed meter value, with an LLM as a fallback for uncertain digits and as an arbiter for rate violations. It is subtle: **most "wrong value" bugs are in post-processing, not in recognition.** Read this before editing.

A full evidence-based analysis of the known failure modes lives in [`docs/llm-fallback-analysis/`](../../docs/llm-fallback-analysis/). Start there for *why*; this skill is the *where* and the *don't-break-this*.

## The three subsystems and their files

1. **Per-digit fallback** — `code/components/jomjol_llm_fallback/LLMFallback.{h,cpp}`
   - `LLMFallbackQueryDigit()` sends one digit-ROI JPEG, returns a digit 0–9 (or −1).
   - Config parsed in `code/components/jomjol_flowcontroll/ClassFlowLLMFallback.cpp::ReadParameter` (the `[LLMFallback]` section). `doFlow` is a **no-op** — this class only loads config.
   - **Called from** `ClassFlowCNNGeneral.cpp`: low-confidence / hard-fail ROIs are pushed to `llmPending` during the CNN loop, then processed **after `delete tflite`** (memory pressure — the HTTP+TLS path needs internal heap). Never move the LLM call back inside the TFLite-loaded region.

2. **Rate-violation arbiter** — same `LLMFallback.cpp` (`LLMFallbackArbitrateValue`, `buildArbiterPrompt`)
   - Sends the **full meter image** asking for the whole value. Gated by `ArbitrateRateViolations` *and* `LLMFallbackIsActive()`.
   - **Called from 3 sites in `ClassFlowPostProcessing.cpp::doFlow`**: the *early/pre-consistency* block (~line 890), the *neg-rate* branch (~line 992), and the *rate-too-high* branch (~line 1095).

3. **Post-processing rate guards** — `ClassFlowPostProcessing.cpp::doFlow` (the big per-`NUMBERS[j]` loop, ~lines 876–1204)
   - Order: assemble raw → `Value = stod(...)` → **early arbiter** → `checkDigitConsistency` → dead-band snap → **neg-rate guard** → **max-rate guard** → commit (`PreValue = Value`).
   - `checkDigitConsistency` (lines ~1322) rewrites high-order digits toward `PreValue` — only valid when input is within one digit of `PreValue`; **its output is unbounded**.
   - Violations that aren't witnessed/arbitrated set `Value = PreValue` and `continue` (clamp + hold). The **two-witness** machinery (`suspectValue`, `hasSuspectReading`, `suspectTimestamp`) promotes a repeated suspect.

## Data flow (one cycle, one number)

```
camera → align → CNN per ROI (result_klasse + confidence)
         └─ low-conf/hard-fail ROIs → llmPending ──(after delete tflite)──► LLMFallbackQueryDigit ► result_klasse
PostProcessing: assemble ReturnRawValue ─► Value
   ├─ early arbiter (if would-violate)         ─► may overwrite Value (BYPASSES guards if accepted)
   ├─ checkDigitConsistency(Value, PreValue)    ─► may rewrite Value (unbounded)
   ├─ neg-rate guard   ─► arbiter | two-witness | clamp-to-PreValue
   ├─ max-rate guard   ─► arbiter | two-witness | clamp-to-PreValue
   └─ commit: PreValue = Value; SavePreValue(); WriteDataLog()
```

## Non-obvious invariants — do not break

- **`PreValue` is load-bearing and persisted** to `/sdcard/config/prevalue.ini`. A bad commit poisons it and *every later cycle* compares against the poison. Treat any path that writes `Value`/`PreValue` as security-critical for accuracy.
- **The guards clamp to `PreValue`, they don't quarantine.** While clamped, the reported value *is* `PreValue`. If `PreValue` is wrong the device gets stuck (multi-hour episodes seen in logs). Don't add a guard that trusts `PreValue` as ground truth without a re-anchor/escape path.
- **The arbiter prompt makes the model echo numbers — it's a prompt bug, not a model one.** The model (`qwen3-vl` in prod) reads the dial fine; but the current prompt states `PreValue` and `currentRaw` as numbers, and transcripts + a live local-model replay show it parrots one of them (~35 % verbatim) instead of reading. **Put no numbers in the arbiter prompt** (a clean digit-by-digit read worked; even forced-choice anchors). Always re-validate the answer against the rate window + plausibility — never trust it as an oracle. See doc 04 §4.3–4.4.
- **Arbiter timeouts are usually the endpoint being down**, not slowness — the prod arbiter model runs on a work PC that isn't always on. Keep `TimeoutMs` small (~20 s) and prefer a fast health-probe/skip so a dead endpoint can't stall the 5-min cycle. A cloud fallback is viable *only after* the call rate is controlled (doc 04 §4.8).
- **Free heap aggressively on the network path.** Request bodies are `swap`'d to release immediately after `esp_http_client_perform`; the arbiter JPEG (`writeToMemoryAsJPG`) is `delete`d right after. Preserve the `LogFile.WriteHeapInfo(...)` markers — they're the only window into heap on-device.
- **`LogConversations`** gates the `/sdcard/log/llm/` transcripts + saved JPEGs, *not* the concise main-log line. When debugging arbiter behaviour, check whether it's even on (it was turned off on this device, so only the INFO `result=` lines in `log/message/` exist).
- **`TimeoutMs` blocks the cycle.** A large timeout (the device had 170000 ms) stalls the whole 5-minute pipeline. Keep it ≤ ~20 s.

## Config keys (`[LLMFallback]`) and where each is read

`Provider, TimeoutMs, MaxTokens, ConfidenceThreshold, Endpoint, ApiKey, Model, ArbiterModel, AdditionalHeaders, Prompt, ArbitrateRateViolations, LogConversations, ArbiterMinIntervalSec` — all parsed in `ClassFlowLLMFallback.cpp::ReadParameter` and mapped into `LLMConfig` (`LLMFallback.h`). Adding a key is a multi-file checklist — use the **`add-config-parameter`** skill; don't hand-edit only the firmware.

Anti-poisoning knobs added in the `feat/llm-arbiter-redesign` work:
- `[PostProcessing] StuckEscapeCycles` (class member, default 6): self-healing re-anchor of a poisoned PreValue after N clamped cycles. Helpers `recordClampSuspect`/`stuckClusterAnchor` in `ClassFlowPostProcessing.cpp`.
- `[LLMFallback] ArbiterMinIntervalSec` (default 0): per-sequence arbiter cooldown; read via `LLMFallbackArbiterMinIntervalSec()`, enforced by `arbiterBudgetAllows`.
- Arbiter answers are gated by `arbiterAnswerAcceptable` (must corroborate live reading or PreValue) at all 3 arbiter sites — do not bypass it.

## How to validate a change (no unit tests in this repo)

1. **Build:** `cd code && platformio run -e esp32cam` (release) — watch the `app` partition size; new buffers can silently overflow it.
2. **Reason from logs, not a debugger.** Pull the device logs over HTTP: crawl `http://<device>/fileserver/log/` (data CSVs in `log/data/`, main log in `log/message/`, transcripts in `log/llm/`). The `data_*.csv` columns are `ts,name,RawValue,Value,PreValue,Rate,ChangeAbs,ErrorMsg,digit1..N`.
3. **Key checks after a guard/arbiter change:**
   - No committed `Value` is implausible (`<0` or `> 10^digits−1`).
   - No `Value` stays pinned while `RawValue` consistently disagrees (stuck detection).
   - Arbiter call count is bounded (it should fire on genuine gross errors only, not every cycle).
4. **Replay:** the saved `log/llm/<ts>_<label>.jpg` is the exact image sent — re-POST it to the endpoint to reproduce an arbiter/digit decision offline.

## Editing etiquette for this branch

- Keep changes **isolated and config-gated** (default-off) so they rebase cleanly onto upstream `jomjol/AI-on-the-edge-device`. Prefer one new file-static helper + one guarded block over reworking the `doFlow` loop.
- Match the surrounding style (German identifier remnants: `Nachkomma`, `aktparamgraph`; `using namespace std;` in `ClassFlow.h`). Don't drive-by rename.
- Every new `[LLMFallback]`/`[PostProcessing]` key needs a `param-docs/parameter-pages/<Section>/<Param>.md` page or CI fails.
