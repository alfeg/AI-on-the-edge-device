# Parameter `PublishGateSlack`
Default Value: `0.02`

Unit: Meter value units (e.g. m³)

!!! Warning
    This is an **Expert Parameter**! Only enable it if you understand what it does!

Absolute tolerance of the publish gate (see `PublishGate`):

- It is added to the rate limit (`PublishGateMaxRate × minutes + PublishGateSlack`), so small reading jitter at short intervals is still published.
- Held readings must agree within `2 × PublishGateSlack` before the gate re-anchors to them.

!!! Note
    Only used when `PublishGate` is `true`. Affects only what is published (MQTT / InfluxDB / Webhook / REST value), never `PreValue`.
