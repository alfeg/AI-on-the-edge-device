# Parameter `MaxTokens`
Default Value: `200`

!!! Warning
    This is an **Expert Parameter**! Only change it if you understand what it does!

Maximum number of tokens the LLM may generate in its response (`max_tokens` for OpenAI, `num_predict` for Ollama).

For **non-thinking models** (e.g. `gpt-4o`, `llava`): a small value like `5`–`20` is sufficient — the model replies with a single digit immediately.

For **thinking/reasoning models** (e.g. `qwen3-vl`, `deepseek-r1`): set this to `200` or higher. These models generate a hidden reasoning chain before the final answer. All reasoning tokens count against this budget, so a value that is too low will truncate the response before the digit is emitted.
