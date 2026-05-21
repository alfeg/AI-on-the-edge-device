# Parameter `LogConversations`
Default Value: `true`

Controls whether the device persists each LLM request and response to the SD card.

When **enabled** (default), every call writes:

- `/sdcard/log/llm/llm_YYYY-MM-DD.txt` — a daily transcript log with one block per call, containing the URL, model, prompt, request body size, full HTTP response body (newlines preserved), and the parsed result. Useful for replaying failed cases offline.
- `/sdcard/log/llm/<timestamp>_<NUMBER>_<ROI>.jpg` — the exact JPEG sent to the LLM.

When **disabled**, neither is written. The concise one-line summary in the main daily log (`/sdcard/log/message/log_YYYY-MM-DD.txt`) is unaffected — you'll still see HTTP status, error codes, and parsed digit/value at INFO/WARN level.

| Setting | Effect |
|---------|--------|
| `true` (default) | Per-call JPEG + transcript saved. ~5–80 KB per call depending on whether it's a digit ROI or full-meter arbiter image. |
| `false` | Nothing extra written to SD. Reduces SD wear and disk pressure on long-running devices. |

!!! Note
    No automatic rotation is implemented for `/sdcard/log/llm/*` files yet. With logging enabled and frequent fallback calls, the directory will grow unbounded — clean it manually or via a cron-style task on the device. Disabling this parameter is the simplest mitigation.

!!! Note
    Disabling logging removes the most useful tool for diagnosing why a particular reading went wrong. Recommended workflow: keep `true` while tuning the model and prompt; flip to `false` once the device is stable.
