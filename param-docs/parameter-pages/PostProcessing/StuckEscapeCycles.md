# Parameter `StuckEscapeCycles`
Default Value: `6`

!!! Warning
    This is an **Expert Parameter**! Only enable it if you understand what it does!

Self-healing recovery for a *poisoned* `PreValue`.

When a reading violates the rate guards (negative rate or rate-too-high) it is normally rejected and the device reports the previous value (`PreValue`) instead, holding the suspect for two-witness confirmation. If `PreValue` itself has become wrong (e.g. a single bad commit), every subsequent *correct* reading then looks like a violation and is rejected too — so the meter can stay stuck on the wrong value for hours.

`StuckEscapeCycles` bounds that. If the live reading has been clamped back to `PreValue` for this many consecutive cycles, **and** the rejected readings agree with *each other* (within a tolerance derived from `MaxRateValue`) and are physically plausible, the firmware concludes that `PreValue` is the outlier and re-anchors it to the median of those readings. A warning is logged (`Stuck recovery: PreValue re-anchored …`).

| Setting | Effect |
|---------|--------|
| `0` | Disabled — legacy behaviour; a poisoned `PreValue` is only corrected by the two-witness logic. |
| `6` *(default)* | Re-anchor after ~6 consecutive clamped cycles of mutually-agreeing readings (≈30 min at a 5-minute cadence). |
| higher | More conservative — requires a longer run of agreeing readings before overriding `PreValue`. |

!!! Note
    Re-anchoring compares the rejected readings to **each other**, not to `PreValue`. A sustained cluster of readings that agree with one another but disagree with `PreValue` is strong evidence that `PreValue`, not the readings, is wrong.
