# Parameter `PublishGateEscapeDown`
Default Value: `12`

Unit: Cycles

!!! Warning
    This is an **Expert Parameter**! Only enable it if you understand what it does!

Number of held cycles after which the publish gate (see `PublishGate`) may move its internal anchor **down** to an agreeing cluster of readings. This recovers from a wrong (too high) anchor, e.g. a misread that was published.

Even after a downward re-anchor, nothing is published until the readings climb back above the last published value, so the published value never decreases. To correct a published value immediately, set the previous value manually (`/setPreValue`), which re-seeds the gate.

Minimum: `1`. With a 5-minute cycle, `12` is about one hour.

!!! Note
    Only used when `PublishGate` is `true`. Affects only what is published (MQTT / InfluxDB / Webhook / REST value), never `PreValue`.
