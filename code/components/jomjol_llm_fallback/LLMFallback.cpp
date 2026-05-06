#include "LLMFallback.h"

#include <string>
#include <vector>
#include <utility>
#include <cstring>
#include <cctype>
#include <cstdio>
#include <cstdlib>
#include <ctime>
#include <functional>

#include "esp_log.h"
#include "esp_http_client.h"
#include "esp_crt_bundle.h"
#include "cJSON.h"

#include "ClassLogFile.h"

static const char* TAG = "LLMFallback";

/* --------------------------------------------------------------------------
 * Module-level state
 * -------------------------------------------------------------------------- */

static LLMConfig s_cfg;
static bool      s_active         = false;  // per-digit fallback ready
static bool      s_arbiterActive  = false;  // rate-violation arbiter ready

// Parsed extra headers
static std::vector<std::pair<std::string, std::string>> s_headers;

/* --------------------------------------------------------------------------
 * Response capture context (used in HTTP event handler)
 * -------------------------------------------------------------------------- */

#define LLM_RESPONSE_BUFFER_SIZE 4096

struct LLMResponseCtx {
    char buf[LLM_RESPONSE_BUFFER_SIZE];
    int  len;
};

/* --------------------------------------------------------------------------
 * Internal helpers
 * -------------------------------------------------------------------------- */

/** Simple base64 encoder — avoids pulling in mbedtls just for this. */
static size_t base64_encode(char* dst, size_t dstLen, const uint8_t* src, size_t srcLen)
{
    static const char TABLE[] =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    size_t needed = 4 * ((srcLen + 2) / 3);
    if (!dst || dstLen < needed + 1) return needed;

    size_t i = 0, j = 0;
    while (i + 2 < srcLen) {
        uint32_t n = (uint32_t(src[i]) << 16) | (uint32_t(src[i+1]) << 8) | src[i+2];
        dst[j++] = TABLE[(n >> 18) & 0x3F];
        dst[j++] = TABLE[(n >> 12) & 0x3F];
        dst[j++] = TABLE[(n >> 6) & 0x3F];
        dst[j++] = TABLE[n & 0x3F];
        i += 3;
    }
    if (i < srcLen) {
        uint32_t n = uint32_t(src[i]) << 16;
        if (i + 1 < srcLen) n |= uint32_t(src[i+1]) << 8;
        dst[j++] = TABLE[(n >> 18) & 0x3F];
        dst[j++] = TABLE[(n >> 12) & 0x3F];
        dst[j++] = (i + 1 < srcLen) ? TABLE[(n >> 6) & 0x3F] : '=';
        dst[j++] = '=';
    }
    dst[j] = '\0';
    return j;
}

/**
 * Parse a pipe-separated "Name=Value|Name2=Value2" header string into pairs.
 * Splits on the FIRST '=' in each token so values may contain '='.
 */
static std::vector<std::pair<std::string, std::string>> parseHeaders(const std::string& raw)
{
    std::vector<std::pair<std::string, std::string>> result;
    if (raw.empty()) return result;

    size_t start = 0;
    while (start <= raw.size()) {
        size_t pipe = raw.find('|', start);
        if (pipe == std::string::npos) pipe = raw.size();

        std::string token = raw.substr(start, pipe - start);
        size_t eq = token.find('=');
        if (eq != std::string::npos && eq > 0) {
            std::string name = token.substr(0, eq);
            std::string val  = token.substr(eq + 1);
            if (!name.empty()) {
                result.push_back({name, val});
            }
        }
        start = pipe + 1;
    }
    return result;
}

/** Trim leading/trailing whitespace from a string in-place. */
static std::string trimStr(const std::string& s)
{
    size_t b = s.find_first_not_of(" \t\r\n");
    if (b == std::string::npos) return "";
    size_t e = s.find_last_not_of(" \t\r\n");
    return s.substr(b, e - b + 1);
}

/** HTTP event handler that accumulates response body into LLMResponseCtx. */
static esp_err_t llm_http_event_handler(esp_http_client_event_t* evt)
{
    LLMResponseCtx* ctx = static_cast<LLMResponseCtx*>(evt->user_data);
    if (!ctx) return ESP_OK;

    switch (evt->event_id) {
        case HTTP_EVENT_ON_DATA: {
            int copy = evt->data_len;
            if (ctx->len + copy >= LLM_RESPONSE_BUFFER_SIZE - 1) {
                copy = LLM_RESPONSE_BUFFER_SIZE - 1 - ctx->len;
            }
            if (copy > 0) {
                memcpy(ctx->buf + ctx->len, evt->data, copy);
                ctx->len += copy;
            }
            break;
        }
        case HTTP_EVENT_ON_FINISH:
            ctx->buf[ctx->len] = '\0';
            break;
        default:
            break;
    }
    return ESP_OK;
}

static const char* DEFAULT_PROMPT =
    "This image shows a single digit on a utility meter display. "
    "It's a rolling meter.  Some parts of other numbers maybe visible. "
    "Reply with ONLY the single digit (0-9) you see. "
    "If you cannot determine the digit, reply with the letter N.";

/** Build the OpenAI chat/completions request body. */
static std::string buildOpenAIBody(const std::string& model, const char* b64, int maxTokens,
                                   const std::string& prompt)
{
    const char* p = prompt.empty() ? DEFAULT_PROMPT : prompt.c_str();

    std::string body;
    body.reserve(strlen(b64) + 512);
    body  = "{\"model\":\"";
    body += model;
    body += "\",\"messages\":[{\"role\":\"user\",\"content\":["
            "{\"type\":\"text\",\"text\":\"";
    body += p;
    body += "\"},{\"type\":\"image_url\",\"image_url\":"
            "{\"url\":\"data:image/jpeg;base64,";
    body += b64;
    body += "\"}}]}],\"max_tokens\":";
    body += std::to_string(maxTokens);
    body += ",\"temperature\":0}";
    return body;
}

/** Build the Ollama /api/chat request body. */
static std::string buildOllamaBody(const std::string& model, const char* b64, int maxTokens,
                                   const std::string& prompt)
{
    const char* p = prompt.empty() ? DEFAULT_PROMPT : prompt.c_str();

    std::string body;
    body.reserve(strlen(b64) + 256);
    body  = "{\"model\":\"";
    body += model;
    body += "\",\"messages\":[{\"role\":\"user\",\"content\":\"";
    body += p;
    body += "\",\"images\":[\"";
    body += b64;
    body += "\"]}],\"stream\":false,\"think\":false,\"options\":{\"temperature\":0,\"num_predict\":";
    body += std::to_string(maxTokens);
    body += "}}";
    return body;
}

/**
 * Extract the digit from an LLM response JSON string.
 * Returns 0-9 on success, -1 on failure.
 */
static int parseDigitFromResponse(const char* json, LLMProvider provider)
{
    cJSON* root = cJSON_Parse(json);
    if (!root) {
        LogFile.WriteToFile(ESP_LOG_WARN, TAG, "LLM response JSON parse failed");
        return -1;
    }

    const char* content = nullptr;

    if (provider == LLMProvider::OpenAI) {
        // choices[0].message.content
        cJSON* choices = cJSON_GetObjectItem(root, "choices");
        if (cJSON_IsArray(choices) && cJSON_GetArraySize(choices) > 0) {
            cJSON* first   = cJSON_GetArrayItem(choices, 0);
            cJSON* message = cJSON_GetObjectItem(first, "message");
            cJSON* cnt     = cJSON_GetObjectItem(message, "content");
            if (cJSON_IsString(cnt)) content = cnt->valuestring;
        }
    } else {
        // message.content
        cJSON* message = cJSON_GetObjectItem(root, "message");
        cJSON* cnt     = cJSON_GetObjectItem(message, "content");
        if (cJSON_IsString(cnt)) content = cnt->valuestring;
    }

    int digit = -1;
    if (content) {
        std::string s = trimStr(std::string(content));
        if (s.size() == 1 && s[0] >= '0' && s[0] <= '9') {
            digit = s[0] - '0';
        } else {
            LogFile.WriteToFile(ESP_LOG_WARN, TAG,
                "LLM returned non-digit content: '" + s + "'");
        }
    } else {
        LogFile.WriteToFile(ESP_LOG_WARN, TAG, "LLM response missing content field");
    }

    cJSON_Delete(root);
    return digit;
}

/**
 * Extract a numeric value from an LLM response. The model is asked to reply
 * with just a number, but in practice may wrap it in prose ("the value is
 * 2173.401") or units. Scan for the first numeric token (sign, digits, dot)
 * and parse it via strtod.
 *
 * Returns true on success, false if no parseable number was found.
 */
static bool parseNumberFromResponse(const char* json, LLMProvider provider, double* out)
{
    if (!json || !out) return false;

    cJSON* root = cJSON_Parse(json);
    if (!root) {
        LogFile.WriteToFile(ESP_LOG_WARN, TAG, "LLM arbiter: response JSON parse failed");
        return false;
    }

    const char* content = nullptr;
    if (provider == LLMProvider::OpenAI) {
        cJSON* choices = cJSON_GetObjectItem(root, "choices");
        if (cJSON_IsArray(choices) && cJSON_GetArraySize(choices) > 0) {
            cJSON* first   = cJSON_GetArrayItem(choices, 0);
            cJSON* message = cJSON_GetObjectItem(first, "message");
            cJSON* cnt     = cJSON_GetObjectItem(message, "content");
            if (cJSON_IsString(cnt)) content = cnt->valuestring;
        }
    } else {
        cJSON* message = cJSON_GetObjectItem(root, "message");
        cJSON* cnt     = cJSON_GetObjectItem(message, "content");
        if (cJSON_IsString(cnt)) content = cnt->valuestring;
    }

    bool ok = false;
    if (content) {
        std::string s = trimStr(std::string(content));

        // Find the first numeric token (optional sign, digits, optional dot, digits).
        size_t i = 0;
        while (i < s.size() && !((s[i] >= '0' && s[i] <= '9') || s[i] == '-' || s[i] == '+')) {
            ++i;
        }
        if (i < s.size()) {
            char* endptr = nullptr;
            double v = strtod(s.c_str() + i, &endptr);
            if (endptr != s.c_str() + i) {
                *out = v;
                ok = true;
            }
        }
        if (!ok) {
            LogFile.WriteToFile(ESP_LOG_WARN, TAG,
                "LLM arbiter: non-numeric content: '" + s + "'");
        }
    } else {
        LogFile.WriteToFile(ESP_LOG_WARN, TAG, "LLM arbiter: response missing content field");
    }

    cJSON_Delete(root);
    return ok;
}

/** Build the dynamic arbiter prompt with PreValue/Raw/elapsed/maxRate substituted in. */
static std::string buildArbiterPrompt(double preValue, double currentRaw,
                                      double minutesElapsed, double maxRate,
                                      int decimalPlaces)
{
    char buf[768];
    int n = snprintf(buf, sizeof(buf),
        "This image shows the face of a utility meter. The previous accepted reading was %.*f "
        "(%.1f minutes ago). A computer vision model just read the meter as %.*f, but that change "
        "exceeds the maximum plausible rate of %.*f per minute, so the CNN may be wrong. "
        "Look at the image yourself and reply with the actual current meter value as a single number "
        "with %d decimal place(s). Reply with ONLY the number — no words, no units, no explanation. "
        "If you genuinely cannot read the meter, reply with the single uppercase letter N.",
        decimalPlaces, preValue,
        minutesElapsed,
        decimalPlaces, currentRaw,
        decimalPlaces, maxRate,
        decimalPlaces);
    if (n < 0) return std::string();
    return std::string(buf);
}

/** Sanitise a caller-supplied label so it's safe for use in a filename. */
static std::string sanitiseLabel(const std::string& in)
{
    std::string out;
    out.reserve(in.size());
    for (char c : in) {
        if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
            (c >= '0' && c <= '9') || c == '_' || c == '-') {
            out += c;
        }
    }
    return out;
}

/* --------------------------------------------------------------------------
 * Shared HTTP + transcript helper. Used by both QueryDigit and ArbitrateValue
 * so they share JPEG persistence, transcript layout, and main-log policy.
 *
 * `responseHandler` is invoked once with the raw response body, length, and
 * transport state — it's responsible for parsing whatever the caller cares
 * about and returning a short string for the transcript "Result:" line.
 * The handler is called even on transport errors (with err != ESP_OK / non-200)
 * so it can record "FAIL".
 * -------------------------------------------------------------------------- */

using LLMResponseHandler = std::function<std::string(const char* body, int bodyLen, esp_err_t err, int httpStatus)>;

static void llmDoRequest(const uint8_t* jpegData, size_t jpegLen,
                         const std::string& prompt,
                         const std::string& label,
                         const std::string& context,
                         const LLMResponseHandler& responseHandler)
{
    LogFile.WriteHeapInfo("llmDoRequest - entry");

    // 0. Timestamp + persist the JPEG (so even hard early failures leave evidence).
    char tsHuman[32];
    char tsFile[32];
    {
        time_t rawtime;
        time(&rawtime);
        struct tm* ti = localtime(&rawtime);
        strftime(tsHuman, sizeof(tsHuman), "%Y-%m-%dT%H:%M:%S", ti);
        strftime(tsFile,  sizeof(tsFile),  "%Y-%m-%d_%H-%M-%S", ti);
    }

    std::string safeLabel = sanitiseLabel(label);
    std::string jpgName = std::string(tsFile);
    if (!safeLabel.empty()) jpgName += "_" + safeLabel;
    jpgName += ".jpg";
    std::string jpgPath = "/sdcard/log/llm/" + jpgName;
    {
        FILE* f = fopen(jpgPath.c_str(), "wb");
        if (f) {
            fwrite(jpegData, 1, jpegLen, f);
            fclose(f);
        } else {
            LogFile.WriteToFile(ESP_LOG_WARN, TAG, "LLM: can't save image to " + jpgPath);
        }
    }

    // 1. Base64-encode the JPEG.
    size_t b64Needed = base64_encode(nullptr, 0, jpegData, jpegLen);
    char* b64Buf = static_cast<char*>(malloc(b64Needed + 1));
    if (!b64Buf) {
        LogFile.WriteToFile(ESP_LOG_ERROR, TAG, "LLM: failed to alloc base64 buffer");
        return;
    }
    size_t b64Len = base64_encode(b64Buf, b64Needed + 1, jpegData, jpegLen);
    b64Buf[b64Len] = '\0';

    // 2. Build URL + body.
    std::string url, body;
    if (s_cfg.provider == LLMProvider::OpenAI) {
        url  = s_cfg.endpoint + "/chat/completions";
        body = buildOpenAIBody(s_cfg.model, b64Buf, s_cfg.maxTokens, prompt);
    } else {
        url  = s_cfg.endpoint + "/api/chat";
        body = buildOllamaBody(s_cfg.model, b64Buf, s_cfg.maxTokens, prompt);
    }
    free(b64Buf);
    b64Buf = nullptr;

    // 3. Allocate response buffer on the heap (4 KB on task stack would overflow).
    LLMResponseCtx* ctxPtr = static_cast<LLMResponseCtx*>(malloc(sizeof(LLMResponseCtx)));
    if (!ctxPtr) {
        LogFile.WriteToFile(ESP_LOG_ERROR, TAG, "LLM: failed to alloc response buffer");
        return;
    }
    ctxPtr->len = 0;
    ctxPtr->buf[0] = '\0';

    // 4. HTTP setup + perform.
    bool useTls = (url.substr(0, 8) == "https://");
    esp_http_client_config_t httpCfg = {};
    httpCfg.url           = url.c_str();
    httpCfg.method        = HTTP_METHOD_POST;
    httpCfg.event_handler = llm_http_event_handler;
    httpCfg.user_data     = ctxPtr;
    httpCfg.timeout_ms    = s_cfg.timeoutMs;
    httpCfg.buffer_size   = LLM_RESPONSE_BUFFER_SIZE;
    if (useTls) httpCfg.crt_bundle_attach = esp_crt_bundle_attach;

    esp_http_client_handle_t client = esp_http_client_init(&httpCfg);
    if (!client) {
        LogFile.WriteToFile(ESP_LOG_ERROR, TAG, "LLM: failed to init HTTP client");
        free(ctxPtr);
        return;
    }

    esp_http_client_set_header(client, "Content-Type", "application/json");
    if (!s_cfg.apiKey.empty()) {
        std::string authVal = "Bearer " + s_cfg.apiKey;
        esp_http_client_set_header(client, "Authorization", authVal.c_str());
    }
    for (const auto& h : s_headers) {
        esp_http_client_set_header(client, h.first.c_str(), h.second.c_str());
    }

    esp_http_client_set_post_field(client, body.c_str(), static_cast<int>(body.size()));

    LogFile.WriteHeapInfo("llmDoRequest - before HTTP perform");
    esp_err_t err = esp_http_client_perform(client);

    // Free the (potentially ~170 KB) JSON body immediately after send.
    size_t bodyFullSize = body.size();
    std::string().swap(body);

    LogFile.WriteHeapInfo("llmDoRequest - after HTTP perform");
    int statusCode = esp_http_client_get_status_code(client);
    esp_http_client_cleanup(client);

    // 5. Hand the raw response to the caller's parser.
    std::string resultStr =
        responseHandler ? responseHandler(ctxPtr->buf, ctxPtr->len, err, statusCode)
                        : std::string("FAIL");

    // 6. Concise main-log line.
    const std::string providerName = (s_cfg.provider == LLMProvider::OpenAI) ? "OpenAI" : "Ollama";
    if (err != ESP_OK) {
        std::string msg = "LLM: HTTP request failed (";
        msg += esp_err_to_name(err);
        msg += ", err=" + std::to_string(err) + ")";
        if (err == ESP_ERR_HTTP_EAGAIN) {
            msg += " — TIMEOUT after " + std::to_string(s_cfg.timeoutMs) +
                   "ms; increase [LLMFallback] TimeoutMs in config.ini";
        }
        LogFile.WriteToFile(ESP_LOG_WARN, TAG, msg);
    } else if (statusCode != 200) {
        std::string preview(ctxPtr->buf, ctxPtr->len);
        LogFile.WriteToFile(ESP_LOG_WARN, TAG,
            "LLM: HTTP " + std::to_string(statusCode) +
            " RESP(" + std::to_string(ctxPtr->len) + "B): " + preview);
    } else {
        LogFile.WriteToFile(ESP_LOG_INFO, TAG,
            "LLM: " + providerName + " " + url + " HTTP=200 result=" + resultStr);
    }

    // 7. Full transcript on disk.
    {
        std::string entry;
        entry.reserve(1024 + ctxPtr->len);
        entry  = "=== ";
        entry += tsHuman;
        entry += " ";
        entry += safeLabel.empty() ? std::string("(no-label)") : safeLabel;
        entry += " ===\n";
        entry += "Image:    " + jpgName + " (" + std::to_string(jpegLen) + "B JPEG)\n";
        if (!context.empty()) entry += "Context:  " + context + "\n";
        entry += "URL:      " + url + "\n";
        entry += "Provider: " + providerName + "\n";
        entry += "Model:    " + s_cfg.model + "\n";
        entry += "Prompt:   " + prompt + "\n";
        entry += "ReqBody:  " + std::to_string(bodyFullSize) + "B (image inlined as base64)\n";
        if (err != ESP_OK) {
            entry += "HTTP:     ERROR ";
            entry += esp_err_to_name(err);
            entry += " (err=" + std::to_string(err) + ")";
            if (err == ESP_ERR_HTTP_EAGAIN) {
                entry += " — TIMEOUT after " + std::to_string(s_cfg.timeoutMs) + "ms";
            }
            entry += "\n";
        } else {
            entry += "HTTP:     " + std::to_string(statusCode) + "\n";
        }
        entry += "Response (" + std::to_string(ctxPtr->len) + "B";
        if (ctxPtr->len >= LLM_RESPONSE_BUFFER_SIZE - 1) {
            entry += ", TRUNCATED at buffer limit";
        }
        entry += "):\n";
        if (ctxPtr->len > 0) {
            entry.append(ctxPtr->buf, ctxPtr->len);
            if (entry.back() != '\n') entry += '\n';
        } else {
            entry += "(empty)\n";
        }
        entry += "Result:   " + resultStr + "\n\n";

        LogFile.WriteToLLMLog(entry);
    }

    free(ctxPtr);
}

/* --------------------------------------------------------------------------
 * Public API
 * -------------------------------------------------------------------------- */

void LLMFallbackInit(const LLMConfig& cfg)
{
    LogFile.WriteHeapInfo("LLMFallbackInit - start");
    s_cfg = cfg;
    s_headers = parseHeaders(cfg.extraHeaders);

    s_active        = (cfg.provider != LLMProvider::None) && !cfg.endpoint.empty();
    s_arbiterActive = s_active && cfg.arbitrateRateViolations;

    LogFile.WriteHeapInfo("LLMFallbackInit - done");
    if (s_active) {
        std::string provider = (cfg.provider == LLMProvider::OpenAI) ? "OpenAI" : "Ollama";
        LogFile.WriteToFile(ESP_LOG_INFO, TAG,
            "LLM fallback active. Provider=" + provider +
            " ConfidenceThreshold=" + std::to_string(cfg.confidenceThreshold) +
            " ArbitrateRateViolations=" + (s_arbiterActive ? "true" : "false"));
    } else {
        LogFile.WriteToFile(ESP_LOG_INFO, TAG, "LLM fallback disabled");
    }
}

bool LLMFallbackIsActive()
{
    return s_active;
}

bool LLMFallbackArbiterEnabled()
{
    return s_arbiterActive;
}

float LLMFallbackGetConfidenceThreshold()
{
    return s_cfg.confidenceThreshold;
}

int LLMFallbackQueryDigit(const uint8_t* jpegData, size_t jpegLen,
                          const std::string& label,
                          const std::string& context)
{
    if (!s_active || !jpegData || jpegLen == 0) return -1;

    const std::string promptUsed =
        s_cfg.prompt.empty() ? std::string(DEFAULT_PROMPT) : s_cfg.prompt;

    int digit = -1;
    llmDoRequest(jpegData, jpegLen, promptUsed, label, context,
        [&](const char* buf, int /*len*/, esp_err_t err, int httpStatus) -> std::string {
            if (err == ESP_OK && httpStatus == 200) {
                digit = parseDigitFromResponse(buf, s_cfg.provider);
            }
            return digit >= 0 ? std::to_string(digit) : std::string("FAIL");
        });

    return digit;
}

bool LLMFallbackArbitrateValue(const uint8_t* jpegData, size_t jpegLen,
                               double preValue, double currentRaw,
                               double minutesElapsed, double maxRate,
                               int decimalPlaces,
                               double* outValue,
                               const std::string& label)
{
    if (!s_arbiterActive || !jpegData || jpegLen == 0 || !outValue) return false;

    const std::string prompt =
        buildArbiterPrompt(preValue, currentRaw, minutesElapsed, maxRate, decimalPlaces);

    char ctxBuf[256];
    snprintf(ctxBuf, sizeof(ctxBuf),
        "arbiter pre=%.*f raw=%.*f elapsed=%.1fmin maxRate=%.*f",
        decimalPlaces, preValue,
        decimalPlaces, currentRaw,
        minutesElapsed,
        decimalPlaces, maxRate);
    std::string context(ctxBuf);

    bool   parsed = false;
    double parsedValue = 0;

    llmDoRequest(jpegData, jpegLen, prompt, label, context,
        [&](const char* buf, int /*len*/, esp_err_t err, int httpStatus) -> std::string {
            if (err == ESP_OK && httpStatus == 200) {
                parsed = parseNumberFromResponse(buf, s_cfg.provider, &parsedValue);
            }
            if (parsed) {
                char rb[32];
                snprintf(rb, sizeof(rb), "%.*f", decimalPlaces, parsedValue);
                return std::string(rb);
            }
            return std::string("FAIL");
        });

    if (parsed) {
        *outValue = parsedValue;
        return true;
    }
    return false;
}
