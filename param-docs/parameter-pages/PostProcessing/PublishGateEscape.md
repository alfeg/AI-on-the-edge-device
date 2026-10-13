# Parameter `PublishGateEscape`
Default Value: `3`

Unit: Cycles

!!! Warning
    This is an **Expert Parameter**! Only enable it if you understand what it does!

Number of consecutive held readings that must agree with each other (within `2 × PublishGateSlack`) before the publish gate (see `PublishGate`) re-anchors to their median. This lets the gate follow a real jump (e.g. after the device was offline, or after a long period of high consumption) once it is confirmed by several readings.

An upward re-anchor publishes the median immediately. A downward re-anchor additionally requires `PublishGateEscapeDown` held cycles and never publishes a value below the last published one.

Minimum: `1`.

!!! Note
    Only used when `PublishGate` is `true`. Affects only what is published (MQTT / InfluxDB / Webhook / REST value), never `PreValue`.
