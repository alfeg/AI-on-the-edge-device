# Parameter `MaxTokens`
Default Value: `2048`

!!! Warning
    This is an **Expert Parameter**! Only change it if you understand what it does!

Maximum number of tokens the LLM may generate in its response (`max_tokens` for OpenAI, `num_predict` for Ollama).

For **non-thinking models** (e.g. `gpt-4o`, `llava`): a small value like `5`–`20` is sufficient — the model replies with a single digit immediately.

For **thinking/reasoning models** (e.g. `qwen3-vl`, `gemma`, `deepseek-r1`): keep this high (the `2048` default, or more). These models generate a reasoning chain before the final answer — observed usage is several hundred tokens just to answer with a single number — and all of it counts against this budget, so a low value truncates the response before the answer is emitted. On local hardware there is no cost to a generous budget; only lower it to cap spend on metered cloud APIs.

!!! Note
    For Ollama the firmware sends `"think": false`, which suppresses most of the reasoning chain; the high default is the safety margin for providers/proxies (e.g. OpenAI-compatible endpoints) where reasoning cannot be disabled.
