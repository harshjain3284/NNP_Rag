---
type: Governance Policy
title: Grounding Safeguards and Refusal Policy
description: Rules governing strict factual grounding, hallucination prevention, and evidence sufficiency refusal.
tags: [policy, grounding, refusal, hallucination-prevention, citations]
generated:
  by: reference_agent/nnt-rag
  at: 2026-10-28T12:00:00Z
verified:
  - by: human:admin
    at: 2026-10-28T12:00:00Z
status: stable
sources:
  - id: project-blueprint
    resource: /project_blueprint.md
    title: NNT RAG Project Blueprint
---

# Core Grounding Principle

The system answers questions strictly and exclusively using authorized knowledge from uploaded documents, configured system prompts, and verified knowledge maps. Unrestricted general-knowledge hallucination is explicitly forbidden.

# Dual-Layer Sufficiency Architecture

To enforce reliable grounding, the pipeline implements a two-stage verification gate:

1. **Pre-Generation Quantitative Gate (`sufficiency.ts`)**:
   - Evaluates retrieved chunk count and top cosine similarity score.
   - If chunk count is zero or the top similarity score is below `DEFAULT_MIN_SUFFICIENCY_SCORE = 0.65`, generation short-circuits immediately.
   - The system returns `evidenceSufficient: false` and a structured refusal message, bypassing LLM inference to save latency and token costs.

2. **In-Context Model Refusal Sentinel (`prompt.ts`)**:
   - If retrieved evidence is topically adjacent but cannot substantiate the specific answer, the prompt instructs the model to respond with:
     `INSUFFICIENT_EVIDENCE: <brief explanation of missing facts>`
   - The generator intercepts this sentinel, marks `evidenceSufficient: false`, suppresses fabricated text, and presents an informative refusal.

# Citations Requirement

Every factual claim in an answer must be backed by a bracketed citation tag `[Source i]` mapping directly to a retrieved chunk. Ungrounded claims or invented citations are prohibited.
