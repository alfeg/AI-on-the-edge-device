# Parameter `ArbitrateRateViolations`
Default Value: `false`

!!! Warning
    This is an **Expert Parameter**! Only enable it if you understand what it does!

When **enabled**, post-processing consults the LLM whenever a reading would otherwise be rejected as a rate violation (`Neg. Rate` or `Rate too high`). The LLM is shown the meter image plus context — the previous reading, the CNN's current reading, elapsed time, and the maximum plausible rate — and is asked to **read the meter itself**. Its answer overrides both the CNN reading *and* `PreValue` for that cycle, immediately resolving the deadlock.

This is the most aggressive recovery strategy available. It runs **in addition to** the built-in two-witness rule — the arbiter is tried first; if it succeeds, the witness path is skipped. If it fails (LLM unavailable, timeout, unparseable response), the two-witness rule still kicks in.

| Setting | Effect |
|---------|--------|
| `false` (default) | Rate violations rely on the two-witness rule (recovers in ~1 extra cycle, no LLM calls). |
| `true` | Each rate violation triggers an LLM call to read the meter directly. Recovers in 1 cycle if the LLM responds correctly. |

!!! Note
    Each arbiter call sends the **full meter image** (≈30–80 KB JPEG) to the configured LLM. Costs and latency add up if your meter has frequent legitimate spikes. Recommended only when you've seen a real `PreValue`-poisoning incident or use a fast local model (Ollama on LAN).

!!! Note
    Requires `Provider`, `Endpoint`, and `Model` to be configured. Inherits `TimeoutMs`, `ApiKey`, and `AdditionalHeaders` from the rest of the `[LLMFallback]` section.

The full transcript of every arbiter call (request, response, parsed result, the JPEG that was sent) is written to `/sdcard/log/llm/llm_YYYY-MM-DD.txt` and `/sdcard/log/llm/<timestamp>_<NUMBER>_arb_*.jpg`, so failed arbitrations can be replayed offline.
