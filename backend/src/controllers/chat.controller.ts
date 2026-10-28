import type { Request, Response } from "express";
import { generateAnswer } from "../rag/generation/generator.js";
import { routeChatQuery } from "../rag/okf/index.js";
import type { Citation } from "../rag/generation/types.js";
import type { RetrievalDebugInfo } from "../rag/retrieval/types.js";
import {
  prepareConversation,
  persistChatExchange,
  deleteConversation,
} from "../services/conversation.service.js";
import {
  MAX_MESSAGES_PER_CONVERSATION,
  CONVERSATION_TITLE_MAX_LENGTH,
} from "../config/rag.js";
import { ROLE_NAMES } from "../database/schema.js";

// Standard UUID format validator (8-4-4-4-12 hexadecimal string)
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const validateOptionalUuid = (
  value: unknown,
  paramName: string
): { id?: string; error?: string } => {
  if (value === undefined || value === null) return {};
  if (typeof value !== "string" || !UUID_REGEX.test(value.trim())) {
    return { error: `Invalid ${paramName} format. Expected a valid UUID` };
  }
  return { id: value.trim() };
};

/**
 * Controller handling RAG question-answering requests with multi-turn conversation persistence.
 *
 * Route: POST /api/chat
 * Payload: { query: string, documentId?: string, conversationId?: string }
 */
export const chatController = async (
  req: Request,
  res: Response
): Promise<void> => {
  const rawUserId = req.user?.id;
  const userId =
    typeof rawUserId === "string" && UUID_REGEX.test(rawUserId.trim())
      ? rawUserId.trim()
      : undefined;
  let activeConversationId: string | undefined;
  let isNewConversation = false;

  try {
    const { query, documentId, conversationId, systemPrompt } = (req.body ?? {}) as {
      query?: unknown;
      documentId?: unknown;
      conversationId?: unknown;
      systemPrompt?: unknown;
    };

    // 1. Validate query: required non-empty string
    if (query === undefined || query === null) {
      res.status(400).json({ error: "Query is required" });
      return;
    }
    if (typeof query !== "string") {
      res.status(400).json({ error: "Query must be a string" });
      return;
    }
    const trimmedQuery = query.trim();
    if (trimmedQuery.length === 0) {
      res.status(400).json({ error: "Query cannot be empty" });
      return;
    }

    // 2. Validate optional documentId, conversationId, and systemPrompt
    const docCheck = validateOptionalUuid(documentId, "documentId");
    if (docCheck.error) {
      res.status(400).json({ error: docCheck.error });
      return;
    }

    const convCheck = validateOptionalUuid(conversationId, "conversationId");
    if (convCheck.error) {
      res.status(400).json({ error: convCheck.error });
      return;
    }

    let targetSystemPrompt: string | undefined;
    if (systemPrompt !== undefined && systemPrompt !== null) {
      if (typeof systemPrompt !== "string") {
        res.status(400).json({ error: "systemPrompt must be a string" });
        return;
      }
      const trimmed = systemPrompt.trim();
      if (trimmed.length > 0) {
        targetSystemPrompt = trimmed;
      }
    }

    const targetDocumentId = docCheck.id;
    const targetConversationId = convCheck.id;

    let historyContext: Array<{ role: string; content: string }> = [];

    // 4. Prepare conversation session and context history
    if (userId) {
      const prep = await prepareConversation(userId, trimmedQuery, targetConversationId);
      if ("error" in prep) {
        res.status(404).json({ error: "Conversation not found" });
        return;
      }
      activeConversationId = prep.data.conversationId;
      isNewConversation = prep.data.isNewConversation;
      historyContext = prep.data.historyContext;
    }

    // 5. Pre-retrieval routing gate and answer resolution
    let result: {
      answer: string;
      evidenceSufficient: boolean;
      refusalReason?: string | undefined;
      citations: Citation[];
      modelName: string;
      providerName: string;
      retrievalDebug?: RetrievalDebugInfo | undefined;
    };

    const routingOutcome = await routeChatQuery(trimmedQuery, {
      documentId: targetDocumentId,
    });

    if (routingOutcome.handledDirectly && routingOutcome.result) {
      result = {
        ...routingOutcome.result,
        retrievalDebug: {
          retrievedChunks: [],
          contextChunks: [],
          filterReason: `Bypassed retrieval via query router (${routingOutcome.decision.intent})`,
        },
      };
    } else {
      const generateOpts: {
        documentId?: string;
        conversationHistory?: Array<{ role: string; content: string }>;
        systemPrompt?: string;
      } = {
        conversationHistory: historyContext,
      };
      if (targetDocumentId !== undefined) generateOpts.documentId = targetDocumentId;
      if (targetSystemPrompt !== undefined) generateOpts.systemPrompt = targetSystemPrompt;

      result = await generateAnswer(trimmedQuery, generateOpts);
    }

    // 6. Persist exchange atomically and compute remaining messages & warnings
    let finalConversationId = activeConversationId;
    let finalIsNewConversation = isNewConversation;
    let remainingMessages = MAX_MESSAGES_PER_CONVERSATION;
    let warning: string | null = null;

    if (userId && finalConversationId) {
      const persisted = await persistChatExchange(
        finalConversationId,
        userId,
        trimmedQuery,
        result.answer,
        result.citations,
        isNewConversation
      );
      finalConversationId = persisted.finalConversationId;
      finalIsNewConversation = persisted.isNewConversation;
      remainingMessages = persisted.remainingMessages;
      warning = persisted.warning;
    }

    const isAuthorizedForDebug =
      req.user?.role === ROLE_NAMES.ADMIN ||
      req.user?.role === ROLE_NAMES.SUPER_ADMIN;

    const responsePayload: Record<string, unknown> = {
      conversationId: finalConversationId,
      answer: result.answer,
      evidenceSufficient: result.evidenceSufficient,
      refusalReason: result.refusalReason,
      citations: result.citations,
      modelName: result.modelName,
      providerName: result.providerName,
      remainingMessages,
      warning,
      isNewConversation: finalIsNewConversation,
    };

    if (isAuthorizedForDebug) {
      responsePayload.retrievalDebug = result.retrievalDebug;
    }

    res.status(200).json(responsePayload);
  } catch (error) {
    if (isNewConversation && activeConversationId && userId) {
      try {
        await deleteConversation(activeConversationId, userId);
      } catch {}
    }
    console.error("Error in chatController:", error);
    res.status(500).json({
      error: "Failed to generate answer",
    });
  }
};
