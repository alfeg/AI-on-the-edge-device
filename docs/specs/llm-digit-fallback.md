# LLM Digit Fallback — Feature Specification

## Overview

When the on-device TFLite CNN fails to recognise a digit (class result `N`, i.e. `result_klasse >= 10`) or the confidence score falls below `CNNGoodThreshold` (i.e. `roi.isReject == true`), the device shall send the cropped ROI image to an external LLM vision API (OpenAI-compatible or Ollama) and use the returned digit instead.

---

## 1. New Configuration Parameters

All parameters live in `config.ini` under a new section **`[LLMFallback]`**.  
Both OpenAI-compatible and Ollama sub-sections are supported; they share the same key names under their respective prefixes.

### 1.1 OpenAI-compatible endpoint

| Key | Type | Example | Description |
|-----|------|---------|-------------|
| `OpenAI.Endpoint` | string (URL) | `https://api.openai.com/v1` | Base URL of the OpenAI-compatible API. No trailing slash. |
| `OpenAI.ApiKey` | string | `sk-...` | Bearer token sent as `Authorization: Bearer <key>`. Leave empty if the endpoint does not require authentication. |
| `OpenAI.Model` | string | `gpt-4o-mini` | Model identifier passed in the request body (`"model"` field). |
| `OpenAI.AdditionalHeaders` | string | `X-My-Header=value1\|X-Other=value2` | Pipe-separated list of extra HTTP headers in `name=value` format. |

### 1.2 Ollama endpoint

| Key | Type | Example | Description |
|-----|------|---------|-------------|
| `Ollama.Endpoint` | string (URL) | `http://192.168.1.50:11434` | Base URL of the Ollama server. |
| `Ollama.ApiKey` | string | *(empty)* | Optional bearer token. Ollama typically requires none. |
| `Ollama.Model` | string | `llava:7b` | Model identifier (must support vision input). |
| `Ollama.AdditionalHeaders` | string | `X-Custom=foo` | Pipe-separated extra headers, same format as OpenAI. |

### 1.3 Shared / behaviour keys

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `Provider` | enum | `None` | Active provider: `None`, `OpenAI`, or `Ollama`. Only the selected provider's keys are used. Setting `None` disables the feature entirely. |
| `TimeoutMs` | int | `5000` | HTTP request timeout in milliseconds. |
| `ConfidenceThreshold` | float | `0.0` | Minimum TFLite confidence score **below which** the LLM fallback is triggered, even when the digit was recognised (not rejected). Range `0.0`–`1.0`. See §1.3.1 for examples. |

#### 1.3.1 `ConfidenceThreshold` examples

The existing `CNNGoodThreshold` in `[Digits]` / `[Analog]` marks the hard cut-off below which the CNN result is already flagged `isReject = true`. `ConfidenceThreshold` is an **independent**, looser gate that can catch digits that technically passed the CNN threshold but with low margin.

| `ConfidenceThreshold` | Effect |
|-----------------------|--------|
| `0.0` (default) | LLM is called only on full failures (`isReject = true` or `result_klasse = N`). No extra calls. |
| `0.5` | LLM is also called when the winning CNN class probability is below 50 %. Example: CNN says "3" with 42 % confidence → LLM consulted. CNN says "3" with 80 % → no call. |
| `0.75` | LLM consulted whenever confidence is below 75 %. Aggressive — results in more network calls but catches marginal reads. Suitable when meter digits are partially obscured or dirty. |
| `0.9` | Very aggressive. Nearly every uncertain digit is sent to the LLM. Use only on slow meters where network latency is acceptable. |
| `1.0` | Every recognised digit is sent to LLM. Not recommended — disables the value of local inference. |

> **Note:** `ConfidenceThreshold` is applied to the raw **top-class output value** returned by `tflite->GetOutputValue(bestClass)` (a float in `0.0`–`1.0`). It is separate from and in addition to `CNNGoodThreshold` in the `[Digits]` section.

> **Implicit disable rule:** if the active provider's `Endpoint` key is absent or empty, the feature is treated as disabled — no separate `Enabled` flag is needed. Setting `Provider = None` (or omitting the `[LLMFallback]` section entirely) also disables it.

### 1.4 Example `config.ini` snippet

```ini
[LLMFallback]
Provider = OpenAI
TimeoutMs = 5000
; Call LLM for any digit whose top-class confidence is below 60 %,
; not just fully-rejected ones.
ConfidenceThreshold = 0.6

; Feature is active because OpenAI.Endpoint is non-empty.
; To disable, either remove this section, set Provider = None, or clear the Endpoint value.
OpenAI.Endpoint = https://api.openai.com/v1
OpenAI.ApiKey = sk-xxxxxxxxxxxxxxxxxxxx
OpenAI.Model = gpt-4o-mini
OpenAI.AdditionalHeaders = X-Org-ID=org-abc|X-Project=watermeter

Ollama.Endpoint = http://192.168.1.50:11434
Ollama.ApiKey =
Ollama.Model = llava:7b
Ollama.AdditionalHeaders =
```

---

## 2. Fallback Trigger Conditions

The fallback runs **per-ROI**, inside `ClassFlowCNNGeneral::doNeuralNetwork()`, after the TFLite inference step for a single digit ROI. It is triggered when **any** condition holds:

| Priority | Condition | Source | Meaning |
|----------|-----------|--------|---------|
| 1 | `roi->result_klasse >= 10` | `Digit` CNN type branch (~line 701) | Digit was not recognised at all ("N" in readout) |
| 2 | `roi->isReject == true` | `DoubleHybrid10` confidence check (~line 765) | Confidence (`_fit`) is below `CNNGoodThreshold` |
| 3 | `tflite->GetOutputValue(bestClass) < ConfidenceThreshold` | Any digit CNN type, after `Invoke()` | Digit was recognised but top-class probability is below the configured threshold |

Condition 3 is only evaluated when `ConfidenceThreshold > 0.0`. When none of the conditions hold the LLM path is skipped entirely and no network call is made.

---

## 3. Image Payload Preparation

The ROI image already cropped for the digit is available as `roi->image` (`CImageBasis*`).

Steps:
1. Encode `roi->image` as JPEG (reuse existing `CImageBasis` encode helpers).
2. Base64-encode the JPEG bytes.
3. Build the multimodal API request (see §4 and §5).

Memory constraint: the ESP32-CAM has limited heap. The JPEG encode + base64 buffer must fit in PSRAM. The implementation must allocate from PSRAM (`heap_caps_malloc(size, MALLOC_CAP_SPIRAM)`) and free immediately after the HTTP response is parsed.

---

## 4. OpenAI-compatible API Request

**Endpoint:** `POST {OpenAI.Endpoint}/chat/completions`

**Headers:**
```
Content-Type: application/json
Authorization: Bearer {OpenAI.ApiKey}
{AdditionalHeaders parsed from OpenAI.AdditionalHeaders}
```

**Body (JSON):**
```json
{
  "model": "{OpenAI.Model}",
  "messages": [
    {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "This image shows a single digit on a utility meter display. Reply with ONLY the single digit (0-9) you see. If you cannot determine the digit, reply with the letter N."
        },
        {
          "type": "image_url",
          "image_url": {
            "url": "data:image/jpeg;base64,{base64_image}"
          }
        }
      ]
    }
  ],
  "max_tokens": 5,
  "temperature": 0
}
```

**Response parsing:**
- Extract `choices[0].message.content`, trim whitespace.
- If the value is a single character `0`–`9`, convert to int → `roi->result_klasse`.
- If the value is `N` or anything else, leave `roi->result_klasse` unchanged (keeps "N" in final readout).

---

## 5. Ollama API Request

**Endpoint:** `POST {Ollama.Endpoint}/api/chat`

**Headers:**
```
Content-Type: application/json
Authorization: Bearer {Ollama.ApiKey}   (omitted if ApiKey is empty)
{AdditionalHeaders}
```

**Body (JSON):**
```json
{
  "model": "{Ollama.Model}",
  "messages": [
    {
      "role": "user",
      "content": "This image shows a single digit on a utility meter display. Reply with ONLY the single digit (0-9) you see. If you cannot determine the digit, reply with the letter N.",
      "images": ["{base64_image}"]
    }
  ],
  "stream": false,
  "options": {
    "temperature": 0,
    "num_predict": 5
  }
}
```

**Response parsing:**
- Extract `message.content`, trim whitespace.
- Same digit / "N" logic as §4.

---

## 6. New Source Files

| File | Purpose |
|------|---------|
| `components/jomjol_llm_fallback/LLMFallback.h` | Public API: init, query one ROI |
| `components/jomjol_llm_fallback/LLMFallback.cpp` | Implementation (HTTP client, JSON build/parse) |
| `components/jomjol_llm_fallback/CMakeLists.txt` | IDF component registration |

### 6.1 Public API sketch

```cpp
// LLMFallback.h

#pragma once
#include <string>

enum class LLMProvider { None, OpenAI, Ollama };

struct LLMConfig {
    LLMProvider provider       = LLMProvider::None;
    int         timeoutMs      = 5000;
    // Feature is considered disabled when provider == None OR the active provider's endpoint is empty.

    std::string openaiEndpoint;
    std::string openaiApiKey;
    std::string openaiModel;
    std::string openaiExtraHeaders;   // raw "k=v|k2=v2" string

    std::string ollamaEndpoint;
    std::string ollamaApiKey;
    std::string ollamaModel;
    std::string ollamaExtraHeaders;
};

/**
 * Store configuration. Call once after config.ini is parsed.
 * The feature is considered disabled (and LLMFallbackQueryDigit becomes a no-op
 * returning -1) when provider == None OR the active provider's endpoint string is empty.
 */
void LLMFallbackInit(const LLMConfig& cfg);

/**
 * Send ROI JPEG bytes to the configured LLM and return the recognised digit.
 * Returns 0-9 on success, or -1 if recognition failed / feature disabled.
 */
int LLMFallbackQueryDigit(const uint8_t* jpegData, size_t jpegLen);
```

---

## 7. Integration Point in `ClassFlowCNNGeneral`

Inside `doNeuralNetwork()`, after the per-ROI TFLite inference, add the fallback call:

```cpp
// Pseudocode – exact insertion after existing Digit / DoubleHybrid10 case blocks

bool needsFallback = (GENERAL[n]->ROI[roi]->isReject)
                  || (CNNType == Digit &&
                      (GENERAL[n]->ROI[roi]->result_klasse < 0 ||
                       GENERAL[n]->ROI[roi]->result_klasse >= 10));

if (needsFallback && LLMFallbackQueryDigit != nullptr /* i.e. endpoint non-empty */) {
    // Encode ROI to JPEG into PSRAM buffer
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
                "LLM fallback corrected digit to: " + std::to_string(llmResult));
        }
    }
}
```

---

## 8. `config.ini` Parser Changes

`ClassFlowCNNGeneral::ReadParameter()` is **not** the right place — LLMFallback is global, not per-CNN-type.  
Add a `ReadParameter` implementation to a new `ClassFlowLLMFallback` that hooks into `ClassFlowControll::InitFlow()` alongside the existing flow classes, or parse directly in `configFile.cpp` where global parameters are handled.

The `AdditionalHeaders` string (`k=v|k2=v2`) must be parsed into key/value pairs at config-load time to avoid repeated string processing on every request:
- Split by `|`
- For each token, split on the first `=`
- Store as `std::vector<std::pair<std::string,std::string>>`

---

## 9. Security Considerations

- **API keys in config.ini** are stored in plaintext on the SD card. The SD card is not encrypted by default. Document this limitation clearly in the user-facing documentation.
- **HTTPS** must be used for OpenAI endpoints. The ESP-IDF HTTP client supports TLS; the implementation must set `transport_type = HTTP_TRANSPORT_OVER_SSL` and provide the root CA bundle (`CONFIG_ESP_TLS_SERVER_CERT_SELECT_HOOK` or the built-in Mozilla bundle).  
  For Ollama on a local LAN over plain HTTP this requirement may be relaxed.
- **No user-supplied data is sent** beyond the JPEG image and a fixed prompt; there is no prompt-injection risk from meter readings.
- The API key must **never** be logged at any log level.

---

## 10. Error Handling

| Scenario | Behaviour |
|----------|-----------|
| Network unreachable / timeout | Log warning; keep original `result_klasse` (digit stays "N"). |
| HTTP status != 200 | Log warning with status code; keep original result. |
| Response JSON malformed | Log warning; keep original result. |
| LLM returns multi-char / unexpected string | Treat as unrecognised; keep original result. |
| Heap allocation fails | Log error; skip LLM call entirely; keep original result. |

The fallback must **never** block the main flow loop indefinitely. The `TimeoutMs` config key enforces a hard deadline on the HTTP call.

---

## 11. Out of Scope (this iteration)

- Analog ROI fallback (only digit ROIs are targeted).
- Local model inference on-device (resource constraints).
- Caching / deduplication of LLM calls across flow runs.
- UI changes to the web interface for live LLM status.
- Training data collection from LLM responses.
