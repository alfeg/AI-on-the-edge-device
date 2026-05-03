#include "ClassFlowLLMFallback.h"

#include "Helper.h"
#include "ClassLogFile.h"
#include "esp_log.h"

static const char* TAG = "LLMFallbackCfg";

ClassFlowLLMFallback::ClassFlowLLMFallback(std::vector<ClassFlow*>* lfc)
{
    ListFlowControll = lfc;
    previousElement  = nullptr;
    disabled         = false;
}

bool ClassFlowLLMFallback::ReadParameter(FILE* pfile, string& aktparamgraph)
{
    aktparamgraph = trim(aktparamgraph);

    if (aktparamgraph.size() == 0)
        if (!this->GetNextParagraph(pfile, aktparamgraph))
            return false;

    if (toUpper(aktparamgraph).compare("[LLMFALLBACK]") != 0)
        return false;

    LLMConfig cfg;

    while (this->getNextLine(pfile, &aktparamgraph) && !this->isNewParagraph(aktparamgraph)) {
        // Split on the FIRST '=' only so values with '=' are preserved (e.g. AdditionalHeaders)
        const std::string& line = aktparamgraph;
        size_t eq = line.find('=');
        if (eq == std::string::npos) continue;

        std::string key = toUpper(trim(line.substr(0, eq)));
        std::string val = trim(line.substr(eq + 1));

        if (key == "PROVIDER") {
            std::string uval = toUpper(val);
            if (uval == "OPENAI")      cfg.provider = LLMProvider::OpenAI;
            else if (uval == "OLLAMA") cfg.provider = LLMProvider::Ollama;
            else                       cfg.provider = LLMProvider::None;
        }
        else if (key == "TIMEOUTMS") {
            if (!val.empty()) cfg.timeoutMs = std::stoi(val);
        }
        else if (key == "MAXTOKENS") {
            if (!val.empty()) cfg.maxTokens = std::stoi(val);
        }
        else if (key == "CONFIDENCETHRESHOLD") {
            if (!val.empty()) cfg.confidenceThreshold = std::stof(val);
        }
        else if (key == "ENDPOINT") {
            cfg.endpoint = val;
        }
        else if (key == "APIKEY") {
            cfg.apiKey = val;
        }
        else if (key == "MODEL") {
            cfg.model = val;
        }
        else if (key == "ADDITIONALHEADERS") {
            cfg.extraHeaders = val;
        }
        else if (key == "PROMPT") {
            cfg.prompt = val;
        }
    }

    LLMFallbackInit(cfg);
    return true;
}
