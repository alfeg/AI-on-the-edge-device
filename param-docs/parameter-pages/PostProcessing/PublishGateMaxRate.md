# Parameter `PublishGateMaxRate`
Default Value: `0.03`

Unit: Meter value units per minute (e.g. m³/min)

!!! Warning
    This is an **Expert Parameter**! Only enable it if you understand what it does!

The highest physically possible consumption rate used by the publish gate (see `PublishGate`). A reading is published directly only if it is at most `PublishGateMaxRate × minutes since the anchor + PublishGateSlack` above the anchor. Higher readings are held until they are confirmed.

Choose a value slightly above the real maximum flow of your installation. Example: `0.03` m³/min = 1.8 m³/h.

!!! Note
    Only used when `PublishGate` is `true`. Affects only what is published (MQTT / InfluxDB / Webhook / REST value), never `PreValue`.
