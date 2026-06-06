# Parameter `ArbiterModel`
Default Value: ``

!!! Warning
    This is an **Expert Parameter**! Only enable it if you understand what it does!

Alternative model identifier used exclusively by the rate-violation arbiter (`ArbitrateRateViolations = true`). When set, the arbiter sends the full meter image to this model instead of the one configured in `Model`. Leave empty to reuse `Model` for both the per-digit fallback and the arbiter.

This is useful when you want a fast, cost-effective model (e.g. `gpt-4o-mini`) for routine digit recognition and a more capable model (e.g. `gpt-4o`) only for the rare, harder case of resolving a rate violation.

| Setting | Effect |
|---------|--------|
| *(empty)* | Arbiter uses the same model as the per-digit fallback (`Model`). |
| e.g. `gpt-4o` | Arbiter calls this model; digit fallback still uses `Model`. |

!!! Note
    Only takes effect when `ArbitrateRateViolations = true`. Has no impact on per-digit LLM calls.

!!! Note
    The model must support vision (image) input, just like `Model`.
