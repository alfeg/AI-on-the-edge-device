# Parameter `ApiKey`
Default Value: `undefined`

Bearer token sent in the `Authorization: Bearer <key>` HTTP header with every request.

- **OpenAI:** your `sk-...` secret key from platform.openai.com
- **Ollama:** leave empty — most Ollama deployments do not require authentication

!!! Warning
    The API key is stored **in plaintext** on the SD card in `config.ini`. Keep the SD card physically secure.
