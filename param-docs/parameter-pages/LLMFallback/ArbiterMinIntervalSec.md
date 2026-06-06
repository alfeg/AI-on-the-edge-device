# Parameter `ArbiterMinIntervalSec`
Default Value: `0`

!!! Warning
    This is an **Expert Parameter**! Only enable it if you understand what it does!

Minimum number of seconds between rate-violation **arbiter** calls, per number sequence. Throttles how often the vision model is consulted so that a stuck or rapidly-violating meter cannot trigger an arbiter call on *every* cycle.

Without this limit, a meter whose `PreValue` is wrong violates the rate guard every cycle, so the arbiter (when `ArbitrateRateViolations = true`) is invoked every cycle — hundreds of calls a day, each one a slow image upload. The interval caps that to at most one call per `ArbiterMinIntervalSec`; in between, the firmware falls back to the two-witness / stuck-recovery logic.

The timer is updated on every *attempt* (including timeouts), so an unreachable endpoint cannot be retried every cycle either.

| Setting | Effect |
|---------|--------|
| `0` *(default)* | Unthrottled — the arbiter may run on every violating cycle (legacy behaviour). |
| e.g. `600` | At most one arbiter call every 10 minutes per number sequence. |

!!! Note
    Only relevant when `ArbitrateRateViolations = true`. Pair it with `[PostProcessing] StuckEscapeCycles` so that a poisoned `PreValue` is recovered locally rather than by repeated arbiter calls.
