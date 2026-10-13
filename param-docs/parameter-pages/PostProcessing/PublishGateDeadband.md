# Parameter `PublishGateDeadband`
Default Value: `0.1`

Unit: Meter value units (e.g. m³)

!!! Warning
    This is an **Expert Parameter**! Only enable it if you understand what it does!

Readings that are at most this much **below** the publish gate's anchor (see `PublishGate`) are treated as "unchanged": the anchor is published again instead of a lower value. This absorbs small backward reading noise (e.g. a digit wheel caught between two positions) without holding the value.

Readings further below the anchor are held; nothing lower than the last published value is ever published.

!!! Note
    Only used when `PublishGate` is `true`. Affects only what is published (MQTT / InfluxDB / Webhook / REST value), never `PreValue`.
