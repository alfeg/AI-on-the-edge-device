# Parameter `ConfidenceThreshold`
Default Value: `0.0`

!!! Warning
    This is an **Expert Parameter**! Only change it if you understand what it does!

Minimum CNN confidence score (0.0–1.0) **below which** the LLM fallback is triggered for a digit that was technically recognised (not outright rejected).

At the default of `0.0` the LLM is only called for hard failures (unrecognised digit or `CNNGoodThreshold` rejection). Raising this value causes the LLM to be consulted for low-confidence — but not failed — readings.

| Value | Effect |
|-------|--------|
| `0.0` | LLM called only on full recognition failures. No extra network calls. |
| `0.5` | LLM also called when top-class probability < 50 %. |
| `0.75` | Aggressive. Useful for dirty or partially-obscured meter digits. |
| `0.9` | Very aggressive. Sends nearly all uncertain digits to the LLM. |
| `1.0` | Every digit is sent to the LLM. Not recommended. |

!!! Note
    This threshold applies to the raw **top-class output probability** from the TFLite model and is independent of `CNNGoodThreshold` in the `[Digits]` section.
