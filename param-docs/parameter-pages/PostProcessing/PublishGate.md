# Parameter `PublishGate`
Default Value: `false`

!!! Warning
    This is an **Expert Parameter**! Only enable it if you understand what it does!

A final filter that decides only **what is published**. It is meant for cumulative meters (water, gas, electricity) whose published value must never go down and must never jump faster than physically possible, e.g. for the Home Assistant energy dashboard.

The gate runs after all other post-processing on every cycle, using that cycle's raw reading. It keeps its own anchor (the last trusted reading) and the last published value, per number sequence:

- A reading within `[anchor, anchor + PublishGateMaxRate × minutes + PublishGateSlack]` is published and becomes the new anchor.
- A reading slightly below the anchor (within `PublishGateDeadband`) counts as "unchanged": the anchor is published again.
- Any other reading is **held** (nothing is published). Once `PublishGateEscape` held readings agree with each other (within `2 × PublishGateSlack`), their median becomes the new anchor if it is higher. A lower anchor is only accepted after `PublishGateEscapeDown` held cycles.
- A value below the last published value is **never** published, not even after a downward re-anchor; publishing resumes once readings climb back above it.
- Cycles without a numeric raw reading (e.g. `N` digits) publish nothing.

| Setting | Effect |
|---------|--------|
| `false` | Disabled. Behaviour is exactly as without this feature. |
| `true`  | The value sent to MQTT / InfluxDB / Webhook (and the REST `/value` and `/json` `value` field) is filtered by the gate. When the gate holds, the value is empty for that cycle, so publishers skip it. |

!!! Note
    The gate does **not** change `PreValue`, `prevalue.ini`, the rate checks (`MaxRateValue`, `AllowNegativeRates`, `StuckEscapeCycles`), the error message or the data log. It only replaces the published value. The REST endpoints `/value` and `/json` report the same gated value, so they also show an empty value while the gate holds; use the `raw` / `pre` fields for diagnostics.

!!! Note
    At startup the gate is seeded from `prevalue.ini` (when `PreValueUse` is enabled), so a reboot never publishes a decrease. Setting the previous value manually (`/setPreValue`) re-seeds the gate; that is the only way to make the published value go down.
