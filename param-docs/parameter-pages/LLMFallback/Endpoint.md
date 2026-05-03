# Parameter `Endpoint`
Default Value: `undefined`

Base URL of the LLM API server for the selected provider. No trailing slash.

**OpenAI / OpenAI-compatible:**
- `https://api.openai.com/v1` — OpenAI production
- `https://api.groq.com/openai/v1` — Groq cloud
- `http://192.168.1.50:8080/v1` — local OpenAI-compatible proxy

**Ollama:**
- `http://192.168.1.50:11434`

The path suffix (`/chat/completions` or `/api/chat`) is appended automatically based on the selected `Provider`.

Leaving this empty disables the feature even when `Provider` is set.

!!! Note
    HTTPS endpoints require a valid TLS certificate chain. HTTP is accepted for local/LAN endpoints only.
