---
type: Architecture Component
title: RAG Pipeline Execution Flow
description: End-to-end document ingestion, vector retrieval, and grounded answer synthesis in NNT RAG.
tags: [architecture, pipeline, ingestion, retrieval, generation]
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

# Overview

The NNT RAG pipeline provides grounded question-answering over uploaded multi-format enterprise documents. The system adheres strictly to evidence-based generation, ensuring all answers are backed by verified source citations.

# Ingestion Flow

1. **Upload & Deduplication**: Multi-format files (PDF, DOCX, TXT) are uploaded by authorized administrators. Each file is verified against active document limits (maximum 10 active documents per admin) and fingerprinted using SHA-256 content hashing to eliminate redundant processing.
2. **Layout Parsing**: LlamaParse extracts text, structural Markdown headings, tables, and page boundaries.
3. **Structural Chunking**: Documents are segmented using heading-aware Markdown chunking (`DEFAULT_STRUCTURAL_TARGET = 1000`, `DEFAULT_STRUCTURAL_MAX = 1200`), falling back to sentence splitting when structural nodes exceed limits. Micro-chunks under 300 characters are merged into adjacent content.
4. **Vector Embedding**: Chunks are embedded in batches via an in-process local `Xenova/jina-embeddings-v2-small-en` model (512 dimensions).
5. **Atomic Persistence**: Chunks and vectors are persisted within a single PostgreSQL transaction into `document_chunks`.

# Query & Generation Flow

1. **Semantic Search**: The user query is embedded and matched against `ready` document chunks using pgvector cosine distance (`<=>`).
2. **Sufficiency Gating**: Chunks must pass the quantitative threshold (top similarity >= 0.65). If evidence is insufficient, a structured refusal is returned immediately without calling the LLM.
3. **Context Construction**: Retrieved evidence is formatted as bracketed tags: `[Source i] (Document: "{filename}", Page: {page}, Chunk: {index})`.
4. **Model Execution**: The prompt is processed by the configured LLM (Groq, Gemini, or Ollama). The model is instructed to output the sentinel `INSUFFICIENT_EVIDENCE:` if the context lacks facts to answer the question.
5. **Citation Mapping**: Generated bracketed citations (`[Source i]`) are parsed and mapped back to source chunks for user auditing in the Source Inspector drawer.
