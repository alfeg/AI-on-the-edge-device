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
    LLMProvider provider                = LLMProvider::None;
    int         timeoutMs               = 5000;
    int         maxTokens               = 200;  ///< max_tokens (OpenAI) / num_predict (Ollama); set high enough for thinking models
    float       confidenceThreshold     = 0.0f; ///< 0.0 = only hard failures; >0 also catches low-confidence recognitions
    bool        arbitrateRateViolations = false; ///< When true, ask the LLM to break the tie on neg-rate / rate-too-high before falling back to two-witness logic
    bool        logConversations        = true;  ///< When true, persist each request/response to /sdcard/log/llm/. Disable to save SD wear.
    int         arbiterMinIntervalSec   = 0;     ///< Minimum seconds between rate-arbiter calls per number sequence; 0 = unthrottled. Stops a stuck meter from triggering a call every cycle.

    std::string endpoint;      ///< Base URL — e.g. "https://api.openai.com/v1" or "http://192.168.1.50:11434"
    std::string apiKey;        ///< Bearer token; empty = no auth header
    std::string model;         ///< e.g. "gpt-4o-mini" or "llava:7b"
    std::string arbiterModel;  ///< Alternative model for the rate-violation arbiter; falls back to `model` when empty
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

/**
 * Returns true when the rate-violation arbiter is configured and ready.
 * Independently gated from the per-digit fallback: requires both
 * LLMFallbackIsActive() and the [LLMFallback] ArbitrateRateViolations flag.
 */
bool LLMFallbackArbiterEnabled();

/**
 * Returns the configured minimum interval (seconds) between rate-arbiter calls
 * per number sequence. 0 means unthrottled. Read by ClassFlowPostProcessing to
 * budget how often the vision model is consulted.
 */
int LLMFallbackArbiterMinIntervalSec();

/**
 * Ask the LLM to read the actual meter value when post-processing detects a
 * rate violation. Caller passes a JPEG of the full meter image plus context
 * needed to build a useful prompt.
 *
 * The arbiter is consulted only when the CNN-derived value disagrees with
 * PreValue by more than MaxRateValue allows. The LLM looks at the image and
 * answers with what it actually reads.
 *
 * @param jpegData       JPEG bytes of the full (aligned) meter image.
 * @param jpegLen        Length of jpegData.
 * @param preValue       The previous accepted reading.
 * @param currentRaw     The CNN-derived current reading (the violator).
 * @param minutesElapsed Time since previous reading was committed.
 * @param maxRate        Configured MaxRateValue (per-cycle or per-minute,
 *                       depending on MaxRateType — caller passes whichever
 *                       is meaningful).
 * @param decimalPlaces  Number of decimal digits in the reading.
 * @param outValue       On true return, set to the LLM's parsed reading.
 * @param label          Tag for the saved JPEG and transcript (e.g. number name).
 *
 * @return true on a successful numeric parse; false on feature off, transport
 *         error, or unparseable response. Caller must fall back to its
 *         existing recovery logic when this returns false.
 */
bool LLMFallbackArbitrateValue(const uint8_t* jpegData, size_t jpegLen,
                               double preValue, double currentRaw,
                               double minutesElapsed, double maxRate,
                               int decimalPlaces,
                               double* outValue,
                               const std::string& label = "");

#endif // LLM_FALLBACK_H
