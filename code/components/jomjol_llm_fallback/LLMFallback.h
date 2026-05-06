#pragma once
#ifndef LLM_FALLBACK_H
#define LLM_FALLBACK_H

#include <string>

/**
 * Supported LLM providers for the digit fallback feature.
 */
enum class LLMProvider {
    None,    ///< Feature disabled
    OpenAI,  ///< OpenAI-compatible chat/completions API
    Ollama   ///< Local Ollama server
};

/**
 * Configuration for the LLM digit fallback feature.
 * Populated from the [LLMFallback] section in config.ini and passed to LLMFallbackInit().
 *
 * The feature is disabled when:
 *   - provider == LLMProvider::None, OR
 *   - endpoint is empty.
 */
struct LLMConfig {
    LLMProvider provider            = LLMProvider::None;
    int         timeoutMs           = 5000;
    int         maxTokens           = 200;  ///< max_tokens (OpenAI) / num_predict (Ollama); set high enough for thinking models
    float       confidenceThreshold = 0.0f; ///< 0.0 = only hard failures; >0 also catches low-confidence recognitions

    std::string endpoint;      ///< Base URL — e.g. "https://api.openai.com/v1" or "http://192.168.1.50:11434"
    std::string apiKey;        ///< Bearer token; empty = no auth header
    std::string model;         ///< e.g. "gpt-4o-mini" or "llava:7b"
    std::string extraHeaders;  ///< "Name=Value|Name2=Value2"
    std::string prompt;        ///< System prompt sent with each image; empty = use built-in default
};

/**
 * Initialise the LLM fallback with the given configuration.
 * Must be called once after config.ini is parsed, before any calls to
 * LLMFallbackQueryDigit().  Safe to call again to reconfigure.
 *
 * Sets the feature to inactive when provider == None or the active
 * provider's endpoint is empty.
 */
void LLMFallbackInit(const LLMConfig& cfg);

/**
 * Returns true when the feature is configured and ready to use.
 */
bool LLMFallbackIsActive();

/**
 * Returns the configured confidence threshold (0.0 by default).
 * Used by ClassFlowCNNGeneral to decide whether to call LLMFallbackQueryDigit.
 */
float LLMFallbackGetConfidenceThreshold();

/**
 * Send a JPEG-encoded digit ROI to the configured LLM and return the recognised digit.
 *
 * Writes a full transcript of the conversation (request metadata, response body,
 * parsed result) to /sdcard/log/llm/llm_YYYY-MM-DD.txt, and saves the exact JPEG
 * sent to the LLM as /sdcard/log/llm/<timestamp>_<label>.jpg so failed cases can
 * be replayed.
 *
 * @param jpegData  Pointer to JPEG-encoded image bytes.
 * @param jpegLen   Length of jpegData in bytes.
 * @param label     Caller-provided tag (e.g. ROI name) used in the saved
 *                  JPEG filename and transcript header. Sanitised — only
 *                  [A-Za-z0-9_-] kept.
 * @param context   Free-form string written verbatim into the transcript
 *                  header (e.g. "class=9 conf=0.65 reason=lowConf"). Helps
 *                  explain *why* the LLM was consulted when reading logs.
 * @return          Recognised digit 0-9, or -1 on failure / feature disabled.
 */
int LLMFallbackQueryDigit(const uint8_t* jpegData, size_t jpegLen,
                          const std::string& label = "",
                          const std::string& context = "");

#endif // LLM_FALLBACK_H
