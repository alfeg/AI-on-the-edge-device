# LLM Digit Fallback — Implementation Plan

Reference spec: [llm-digit-fallback.md](llm-digit-fallback.md)

---

## Step 1 — Create the `jomjol_llm_fallback` component skeleton

**Files to create:**

```
code/components/jomjol_llm_fallback/
    CMakeLists.txt
    LLMFallback.h
    LLMFallback.cpp
```

**`CMakeLists.txt`** — mirror the pattern used by `jomjol_webhook`:

```cmake
FILE(GLOB_RECURSE app_sources ${CMAKE_CURRENT_SOURCE_DIR}/*.*)

idf_component_register(SRCS ${app_sources}
                    INCLUDE_DIRS "."
                    REQUIRES esp_http_client jomjol_logfile jomjol_flowcontroll json mbedtls)
```

**`LLMFallback.h`** — paste the public API sketch from spec §6.1, plus one helper:

```cpp
bool LLMFallbackIsActive();   // true when provider != None AND endpoint non-empty
```

**`LLMFallback.cpp`** — stub every function to return `false` / `-1`. This makes the component compile before any real logic is written.

---

## Step 2 — Implement config parsing (`LLMFallback.cpp`)

**`LLMFallbackInit(const LLMConfig& cfg)`**

1. Store the config in a file-static `s_cfg` variable.
2. Parse `openaiExtraHeaders` and `ollamaExtraHeaders` into  
   `std::vector<std::pair<std::string,std::string>> s_openaiHeaders` /  
   `s_ollamaHeaders` using `|` then `=` splits.  
   Helper: `static std::vector<std::pair<std::string,std::string>> parseHeaders(const std::string& raw)`.
3. Determine `s_active`:
   ```cpp
   bool s_active = (cfg.provider == LLMProvider::OpenAI && !cfg.openaiEndpoint.empty())
                || (cfg.provider == LLMProvider::Ollama  && !cfg.ollamaEndpoint.empty());
   ```

**`LLMFallbackIsActive()`** — return `s_active`.

---

## Step 3 — Implement `[LLMFallback]` section in config.ini parser

The `[LLMFallback]` section is **global**, not per-CNN-type. Hook it into
`ClassFlowControll::CreateClassFlow()` and `InitFlow()`.

### 3a — Add `ClassFlowLLMFallback` thin wrapper

Create `ClassFlowLLMFallback.h/.cpp` inside `jomjol_llm_fallback/`:

```cpp
class ClassFlowLLMFallback : public ClassFlow {
public:
    bool ReadParameter(FILE* pfile, string& aktparamgraph) override;
    bool doFlow(string time) override { return true; } // no per-cycle work
    string name() override { return "ClassFlowLLMFallback"; }
};
```

`ReadParameter` reads `[LLMFallback]` key/value lines (reuse the same
`ZerlegeZeile` / `toUpper` helpers used everywhere else), builds an
`LLMConfig`, and calls `LLMFallbackInit(cfg)`.

Keys to parse:

| INI key | `LLMConfig` field |
|---------|-------------------|
| `Provider` | `provider` (parse `"OpenAI"`, `"Ollama"`, anything else → `None`) |
| `TimeoutMs` | `timeoutMs` |
| `OpenAI.Endpoint` | `openaiEndpoint` |
| `OpenAI.ApiKey` | `openaiApiKey` |
| `OpenAI.Model` | `openaiModel` |
| `OpenAI.AdditionalHeaders` | `openaiExtraHeaders` |
| `Ollama.Endpoint` | `ollamaEndpoint` |
| `Ollama.ApiKey` | `ollamaApiKey` |
| `Ollama.Model` | `ollamaModel` |
| `Ollama.AdditionalHeaders` | `ollamaExtraHeaders` |

### 3b — Register in `ClassFlowControll::CreateClassFlow()`

```cpp
// in ClassFlowControll.cpp, inside CreateClassFlow():
if (toUpper(_type).compare("[LLMFALLBACK]") == 0) {
    cfc = new ClassFlowLLMFallback(&FlowControll);
}
```

`ClassFlowLLMFallback` is pushed into `FlowControll` but its `doFlow()` is a
no-op, so it adds zero overhead per measurement cycle.

### 3c — Add `#include "ClassFlowLLMFallback.h"` to `ClassFlowControll.cpp`

---

## Step 4 — Implement JPEG encode helper in `LLMFallback.cpp`

Check whether `CImageBasis` already exposes a  
`SaveToJPEGBuffer(uint8_t** buf, size_t* len, uint32_t caps)` method.

- **If yes:** use it directly.
- **If no:** add the method to `CImageBasis` (in `jomjol_image_proc`) using the
  existing `stbi_write_jpg_to_func` / `fmt2jpg` pattern already used in that
  component for file saves. Buffer must be allocated with
  `heap_caps_malloc(estimatedSize, MALLOC_CAP_SPIRAM)`.

---

## Step 5 — Implement Base64 encode in `LLMFallback.cpp`

ESP-IDF provides `mbedtls_base64_encode` (from `mbedtls`). Use it:

```cpp
size_t b64Len = 0;
mbedtls_base64_encode(nullptr, 0, &b64Len, jpegData, jpegLen); // probe length
char* b64Buf = (char*) heap_caps_malloc(b64Len + 1, MALLOC_CAP_SPIRAM);
mbedtls_base64_encode((uint8_t*)b64Buf, b64Len + 1, &b64Len, jpegData, jpegLen);
b64Buf[b64Len] = '\0';
```

Free `b64Buf` after the HTTP response is received.

---

## Step 6 — Implement `LLMFallbackQueryDigit()` — HTTP request/response

### 6a — Build JSON request body

Avoid a JSON library for the request body — use `std::string` construction
directly (the structure is fully static except for model, base64 string, and
no user-controlled content can reach the JSON template).

Two private helpers:

```cpp
static std::string buildOpenAIBody(const std::string& model, const char* b64);
static std::string buildOllamaBody (const std::string& model, const char* b64);
```

### 6b — HTTP client setup

Reuse the `esp_http_client` pattern from `interface_influxdb.cpp` /
`interface_webhook.cpp`:

1. `esp_http_client_config_t` with:
   - `url` set to the full endpoint path
   - `timeout_ms` from `s_cfg.timeoutMs`
   - `transport_type = HTTP_TRANSPORT_OVER_SSL` for `https://` URLs (detect by
     prefix); `HTTP_TRANSPORT_OVER_TCP` otherwise.
   - `crt_bundle_attach = esp_crt_bundle_attach` for TLS.
2. `esp_http_client_init()`
3. Set method to POST, content-type header, auth header (if key non-empty),
   extra headers from the parsed vector.
4. `esp_http_client_set_post_field()` with the JSON body.
5. `esp_http_client_perform()`.
6. Read response into a PSRAM-allocated buffer (use the
   `MAX_HTTP_OUTPUT_BUFFER` constant already defined in `defines.h`, or define
   a local `LLM_HTTP_RESPONSE_BUFFER_SIZE 2048`).
7. `esp_http_client_cleanup()`.

### 6c — Parse response

The response JSON can be parsed with the lightweight `jsmn` or the `json`
component already listed as a dependency. Parse only the one field needed:

- OpenAI: walk to `choices[0].message.content`
- Ollama: walk to `message.content`

Extract the string value, trim whitespace, and return `strtol` result if it is
a single digit character `'0'`–`'9'`, else return `-1`.

### 6d — Security: never log the API key

The key is only ever used in the `Authorization` header via
`esp_http_client_set_header`. It must not appear in any `ESP_LOG*` or
`LogFile.WriteToFile` call.

---

## Step 7 — Integrate fallback call into `ClassFlowCNNGeneral::doNeuralNetwork()`

**File:** `code/components/jomjol_flowcontroll/ClassFlowCNNGeneral.cpp`

Add `#include "LLMFallback.h"` at the top.

After each ROI inference block (both `Digit` case ~line 701 and the
`DoubleHybrid10` threshold check ~line 765), insert the fallback block from
spec §7:

```cpp
if (LLMFallbackIsActive()) {
    bool needsFallback = GENERAL[n]->ROI[roi]->isReject
                      || (CNNType == Digit &&
                          GENERAL[n]->ROI[roi]->result_klasse >= 10);
    if (needsFallback) {
        uint8_t* jpegBuf = nullptr;
        size_t   jpegLen = 0;
        GENERAL[n]->ROI[roi]->image->SaveToJPEGBuffer(&jpegBuf, &jpegLen, MALLOC_CAP_SPIRAM);
        if (jpegBuf && jpegLen > 0) {
            int llmResult = LLMFallbackQueryDigit(jpegBuf, jpegLen);
            heap_caps_free(jpegBuf);
            if (llmResult >= 0 && llmResult <= 9) {
                GENERAL[n]->ROI[roi]->result_klasse = llmResult;
                GENERAL[n]->ROI[roi]->isReject      = false;
                GENERAL[n]->ROI[roi]->result_float  = (float)llmResult;
                LogFile.WriteToFile(ESP_LOG_INFO, TAG,
                    "LLM fallback corrected ROI " + GENERAL[n]->ROI[roi]->name +
                    " to: " + std::to_string(llmResult));
            }
        }
    }
}
```

Place the check **inside** each CNN-type `case` block, after the existing
`isReject` / `result_klasse` assignments, so it runs only once per ROI.

---

## Step 8 — Wire the new component into the build

**`code/components/jomjol_flowcontroll/CMakeLists.txt`** — add
`jomjol_llm_fallback` to `REQUIRES`.

**`code/CMakeLists.txt`** (top-level) — no change needed; ESP-IDF auto-discovers
components under `components/`.

---

## Step 9 — Verify disable/enable paths compile and behave correctly

Check these three scenarios with a test config before full hardware testing:

| Scenario | `config.ini` | Expected behaviour |
|----------|--------------|--------------------|
| Feature off (no section) | `[LLMFallback]` absent | `LLMFallbackIsActive()` returns `false`; no network calls |
| Feature off (empty endpoint) | `Provider = OpenAI`, `OpenAI.Endpoint =` | same as above |
| Feature on | valid endpoint + model | fallback fires only on rejected/N ROIs |

---

## Step 10 — Manual integration test on hardware

1. Flash firmware, configure `[LLMFallback]` pointing at a local Ollama instance
   (`llava:7b`) or an OpenAI-compatible proxy.
2. Observe log output: `LLM fallback corrected ROI ... to: X` when a digit was
   unrecognised.
3. Verify timing: `TimeoutMs = 5000` must not cause watchdog resets. If it does,
   reduce to 3000 or move the LLM call off the main flow task using a FreeRTOS
   queue (future improvement, out of scope here).
4. Verify the API key does not appear in any log output at any verbosity level.

---

## Dependency / order summary

```
Step 1  ──► Step 2  ──► Step 6  ──► Step 7
                  └──► Step 3  ──┘
Step 4  ──────────────────────────► Step 7
Step 5  ──────────────────────────► Step 6
Step 8  (can be done alongside Step 1)
Step 9  (after Steps 1–8 compile)
Step 10 (last)
```

Steps 1, 4, 5, and 8 are independent and can be done in parallel.
