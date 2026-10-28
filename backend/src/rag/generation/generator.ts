import { retrieveChunks, chunkRetriever } from "../retrieval/retriever.js";
import type {
  RetrievedChunk,
  RetrieveOptions,
  RetrievalDebugChunk,
  ContextChunk,
} from "../retrieval/types.js";
import { getLLMProvider } from "../../providers/llm/index.js";
import {
  DEFAULT_INSUFFICIENT_EVIDENCE_MESSAGE,
  DEFAULT_MIN_SUFFICIENCY_SCORE,
} from "../../config/rag.js";
import { configService } from "../../services/config.service.js";
import { buildRAGPrompt, DEFAULT_RAG_SYSTEM_PROMPT } from "./prompt.js";

import { checkEvidenceSufficiency } from "./sufficiency.js";
import { promptsService } from "../../services/prompts.service.js";
import type {
  Citation,
  GenerateAnswerOptions,
  GenerateAnswerStreamOptions,
  GenerateAnswerResult,
} from "./types.js";

export const extractCitations = (
  answerText: string,
  retrievedChunks: RetrievedChunk[]
): Citation[] => {
  const sourceMatches = Array.from(answerText.matchAll(/\[Source\s+(\d+)\]/gi));
  const citedIndices = new Set<number>();

  for (const match of sourceMatches) {
    const num = Number.parseInt(match[1] || "", 10);
    if (!Number.isNaN(num) && num >= 1 && num <= retrievedChunks.length) {
      citedIndices.add(num - 1);
    }
  }

  const targetChunks =
    citedIndices.size > 0
      ? Array.from(citedIndices)
          .map((idx) => retrievedChunks[idx]!)
          .filter(Boolean)
      : retrievedChunks;

  return targetChunks.map((chunk) => ({
    documentId: chunk.documentId,
    filename: chunk.filename,
    pageNumber: chunk.pageNumber,
    chunkIndex: chunk.chunkIndex,
    chunkId: chunk.id,
    similarity: chunk.similarity,
    snippet: chunk.content.trim(),
  }));
};

/**
 * Streams answer tokens while checking for sufficiency, building RAG prompt, and extracting citations.
 */
export const generateAnswerStream = async (
  query: string,
  options: GenerateAnswerStreamOptions
): Promise<GenerateAnswerResult> => {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    await options.onToken(DEFAULT_INSUFFICIENT_EVIDENCE_MESSAGE);
    return {
      answer: DEFAULT_INSUFFICIENT_EVIDENCE_MESSAGE,
      evidenceSufficient: false,
      refusalReason: "Empty query provided.",
      citations: [],
      retrievedChunks: [],
      modelName: "none",
      providerName: "none",
      retrievalDebug: {
        retrievedChunks: [],
        contextChunks: [],
        filterReason: "Empty query provided.",
      },
    };
  }

  const provider = options?.llmProvider || getLLMProvider();

  // 1. Retrieve relevant chunks using pgvector with candidate debug tracking
  const retrieveOpts: RetrieveOptions = {};
  if (options?.topK !== undefined) retrieveOpts.topK = options.topK;
  if (options?.documentId !== undefined) retrieveOpts.documentId = options.documentId;
  if (options?.minSimilarity !== undefined) retrieveOpts.minSimilarity = options.minSimilarity;
  if (options?.embeddingProvider !== undefined) retrieveOpts.embeddingProvider = options.embeddingProvider;

  let retrievedChunks: RetrievedChunk[] = [];
  let debugCandidates: RetrievalDebugChunk[] = [];

  if (options?.retriever) {
    retrievedChunks = await options.retriever(trimmedQuery, retrieveOpts);
    debugCandidates = retrievedChunks.map((c) => ({
      id: c.id,
      chunkId: c.id,
      documentId: c.documentId,
      filename: c.filename,
      pageNumber: c.pageNumber,
      chunkIndex: c.chunkIndex,
      similarity: c.similarity,
      passedToLLM: true,
      filterReason: null,
    }));
  } else {
    const retrievalResult = await chunkRetriever.retrieveChunksWithDebug(trimmedQuery, retrieveOpts);
    retrievedChunks = retrievalResult.chunks;
    debugCandidates = retrievalResult.debugChunks;
  }

  // 2. Pre-generation evidence sufficiency check
  const runtimeConfig = configService.getProjectConfig();
  const minScore = options?.minSufficiencyScore ?? runtimeConfig.retrieval.minSufficiencyScore ?? DEFAULT_MIN_SUFFICIENCY_SCORE;
  const sufficiency = checkEvidenceSufficiency(retrievedChunks, minScore);

  if (!sufficiency.isSufficient) {
    const updatedDebugChunks = debugCandidates.map((c) => {
      if (c.passedToLLM) {
        return {
          ...c,
          passedToLLM: false,
          filterReason: sufficiency.reason || "Evidence sufficiency threshold not met",
        };
      }
      return c;
    });

    await options.onToken(DEFAULT_INSUFFICIENT_EVIDENCE_MESSAGE);
    return {
      answer: DEFAULT_INSUFFICIENT_EVIDENCE_MESSAGE,
      evidenceSufficient: false,
      refusalReason: sufficiency.reason,
      citations: [],
      retrievedChunks,
      modelName: provider.modelName,
      providerName: provider.providerName,
      retrievalDebug: {
        retrievedChunks: updatedDebugChunks,
        contextChunks: [],
        filterReason: sufficiency.reason ?? null,
      },
    };
  }

  // 3. Resolve system prompt
  let systemPrompt = options?.systemPrompt;
  if (!systemPrompt) {
    try {
      const activePrompt = await promptsService.getActivePrompt("system");
      systemPrompt = activePrompt?.content || DEFAULT_RAG_SYSTEM_PROMPT;
    } catch (err) {
      console.warn("Failed to retrieve active system prompt from database:", err);
      systemPrompt = DEFAULT_RAG_SYSTEM_PROMPT;
    }
  }

  // 4. Build prompt and context chunks
  const contextChunks: ContextChunk[] = retrievedChunks.map((c) => ({
    id: c.id,
    chunkId: c.id,
    documentId: c.documentId,
    filename: c.filename,
    pageNumber: c.pageNumber,
    chunkIndex: c.chunkIndex,
    similarity: c.similarity,
    text: c.content,
    content: c.content,
  }));
  const { systemPrompt: finalSystemPrompt, userPrompt } = buildRAGPrompt(
    trimmedQuery,
    retrievedChunks,
    systemPrompt,
    options?.conversationHistory
  );

  // 5. Generate and stream tokens with sentinel filtering
  const SENTINEL = "INSUFFICIENT_EVIDENCE:";
  let rawResponse = "";
  let buffer = "";
  let isSentinel = false;

  const handleToken = async (token: string) => {
    rawResponse += token;
    if (isSentinel) return;

    if (buffer.length < SENTINEL.length) {
      buffer += token;
      if (SENTINEL.startsWith(buffer.trimStart())) {
        if (buffer.trimStart().startsWith(SENTINEL)) isSentinel = true;
        return;
      }
      const toFlush = buffer;
      buffer = "";
      await options.onToken(toFlush);
    } else {
      await options.onToken(token);
    }
  };

  const finalTemperature = options?.temperature ?? runtimeConfig.generation.temperature ?? 0.1;
  const finalMaxTokens = options?.maxTokens ?? runtimeConfig.generation.maxTokens ?? 1024;

  if (typeof provider.generateStream === "function") {
    await provider.generateStream(userPrompt, handleToken, {
      systemPrompt: finalSystemPrompt,
      temperature: finalTemperature,
      maxTokens: finalMaxTokens,
      signal: options?.signal,
    });
  } else {
    rawResponse = await provider.generate(userPrompt, {
      systemPrompt: finalSystemPrompt,
      temperature: finalTemperature,
      maxTokens: finalMaxTokens,
    });

    if (!rawResponse.startsWith(SENTINEL)) {
      await options.onToken(rawResponse);
    }
  }

  // 6. Check for insufficient evidence sentinel from LLM
  const match = rawResponse.match(/^INSUFFICIENT_EVIDENCE:\s*(.*)/is);
  if (match) {
    const refusalReason =
      match[1]?.trim() ||
      "The retrieved documents do not contain sufficient evidence to answer this question.";
    await options.onToken(DEFAULT_INSUFFICIENT_EVIDENCE_MESSAGE);
    return {
      answer: DEFAULT_INSUFFICIENT_EVIDENCE_MESSAGE,
      evidenceSufficient: false,
      refusalReason,
      citations: [],
      retrievedChunks,
      modelName: provider.modelName,
      providerName: provider.providerName,
      retrievalDebug: {
        retrievedChunks: debugCandidates,
        contextChunks,
        filterReason: refusalReason,
      },
    };
  }

  if (buffer.length > 0 && !isSentinel) {
    await options.onToken(buffer);
  }

  // 7. Extract citations
  const citations = extractCitations(rawResponse, retrievedChunks);

  // Clean trailing bibliography/citations block if generated by LLM
  const cleanedAnswer = rawResponse
    .replace(/\n+\s*(?:Citations|Sources):\s*\n+(?:\[Source\s+\d+\][\s\S]*)+$/i, "")
    .trim();

  return {
    answer: cleanedAnswer || rawResponse,
    evidenceSufficient: true,
    citations,
    retrievedChunks,
    modelName: provider.modelName,
    providerName: provider.providerName,
    retrievalDebug: {
      retrievedChunks: debugCandidates,
      contextChunks,
      filterReason: null,
    },
  };
};

/**
 * Standard non-streaming RAG question answering.
 * Directly reuses generateAnswerStream with a no-op token callback.
 */
export const generateAnswer = async (
  query: string,
  options?: GenerateAnswerOptions
): Promise<GenerateAnswerResult> => {
  return generateAnswerStream(query, {
    ...options,
    onToken: () => {},
  });
};
