# Parameter `TimeoutMs`
Default Value: `5000`

!!! Warning
    This is an **Expert Parameter**! Only change it if you understand what it does!

HTTP request timeout in milliseconds for the LLM fallback call. If the remote API does not respond within this time, the request is aborted and the original CNN result is kept (digit stays `N`).

Reduce this value if LLM latency causes FreeRTOS watchdog resets. Increase it only on reliable, low-latency local networks (e.g. a local Ollama server).
