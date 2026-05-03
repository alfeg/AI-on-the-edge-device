# Parameter `Provider`
Default Value: `None`

Selects which external LLM vision API to use as a fallback when a digit cannot be recognised by the on-device CNN model.

| Value | Meaning |
|-------|---------|
| `None` | Feature disabled. No external calls are made. |
| `OpenAI` | Use an OpenAI-compatible endpoint (see `OpenAI.Endpoint`, `OpenAI.Model`). |
| `Ollama` | Use a local Ollama server (see `Ollama.Endpoint`, `Ollama.Model`). |

The feature is also implicitly disabled if the selected provider's `Endpoint` is left empty.
