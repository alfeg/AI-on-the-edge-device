#pragma once
#ifndef CLASS_FLOW_LLM_FALLBACK_H
#define CLASS_FLOW_LLM_FALLBACK_H

#include "ClassFlow.h"
#include "LLMFallback.h"

/**
 * Reads the [LLMFallback] section from config.ini and initialises the
 * LLMFallback module.  Has no per-cycle work (doFlow is a no-op).
 */
class ClassFlowLLMFallback : public ClassFlow
{
public:
    ClassFlowLLMFallback(std::vector<ClassFlow*>* lfc);

    bool ReadParameter(FILE* pfile, string& aktparamgraph) override;
    bool doFlow(string time) override { return true; }
    string name() override { return "ClassFlowLLMFallback"; }
};

#endif // CLASS_FLOW_LLM_FALLBACK_H
