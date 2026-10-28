import crypto from "node:crypto";
import { WebSocket } from "ws";
import jwt from "jsonwebtoken";
import { JWT_SECRET } from "../config/env.js";
import type { JwtTokenPayload } from "../types/auth.types.js";
import { generateAnswerStream } from "../rag/generation/generator.js";
import { routeChatQuery } from "../rag/okf/index.js";
import type { Citation } from "../rag/generation/types.js";
import type { RetrievalDebugInfo } from "../rag/retrieval/types.js";
import {
  prepareConversation,
  persistChatExchange,
} from "../services/conversation.service.js";
import { ROLE_NAMES } from "../database/schema.js";
import type {
  ChatSendPayload,
  ChatCancelPayload,
  ChatAuthPayload,
  RealtimeEvent,
} from "./events.js";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ClientSession {
  user: { id: string; role: string } | null;
  activeRequests: Map<string, AbortController>;
}

export const verifyAuthToken = (
  token: string
): { id: string; role: string } | null => {
  if (!token || !JWT_SECRET) return null;
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (
      typeof decoded === "object" &&
      decoded &&
      typeof decoded.sub === "string" &&
      "role" in decoded &&
      typeof (decoded as { role: unknown }).role === "string"
    ) {
      const payload = decoded as unknown as JwtTokenPayload;
      return { id: payload.sub, role: payload.role };
    }
    return null;
  } catch {
    return null;
  }
};

export const sendToClient = (
  ws: WebSocket,
  type: RealtimeEvent["type"],
  payload: Record<string, unknown>
): void => {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, payload }));
  }
};

export const handleClientConnection = (
  ws: WebSocket,
  initialUser: { id: string; role: string } | null = null
): ClientSession => {
  const session: ClientSession = {
    user: initialUser,
    activeRequests: new Map<string, AbortController>(),
  };

  ws.on("message", async (rawMessage: Buffer | string) => {
    let parsed: { type?: unknown; payload?: unknown };
    try {
      parsed = JSON.parse(rawMessage.toString());
    } catch {
      sendToClient(ws, "chat.error", {
        error: "Malformed message: invalid JSON",
        statusCode: 400,
      });
      return;
    }

    if (!parsed || typeof parsed !== "object" || typeof parsed.type !== "string") {
      sendToClient(ws, "chat.error", {
        error: "Invalid message structure: expected { type, payload }",
        statusCode: 400,
      });
      return;
    }

    const { type, payload = {} } = parsed as {
      type: string;
      payload: Record<string, unknown>;
    };

    // 1. Authentication Event
    if (type === "auth") {
      const { token } = payload as unknown as ChatAuthPayload;
      const verified = typeof token === "string" ? verifyAuthToken(token.trim()) : null;
      if (!verified) {
        sendToClient(ws, "auth.error", { error: "Unauthorized: Invalid or expired token" });
        return;
      }
      session.user = verified;
      sendToClient(ws, "auth.success", {
        userId: verified.id,
        role: verified.role,
        message: "Authenticated successfully",
      });
      return;
    }

    // 2. Cancellation Event
    if (type === "chat.cancel") {
      const { requestId } = payload as unknown as ChatCancelPayload;
      if (requestId && session.activeRequests.has(requestId)) {
        session.activeRequests.get(requestId)?.abort();
        session.activeRequests.delete(requestId);
      }
      return;
    }

    // 3. Chat Send Event
    if (type === "chat.send") {
      const chatPayload = payload as unknown as ChatSendPayload;
      const requestId =
        typeof chatPayload.requestId === "string" && chatPayload.requestId.trim()
          ? chatPayload.requestId.trim()
          : crypto.randomUUID();

      // Optional inline token
      if (typeof chatPayload.token === "string" && chatPayload.token.trim()) {
        const verified = verifyAuthToken(chatPayload.token.trim());
        if (verified) session.user = verified;
      }

      if (!session.user) {
        sendToClient(ws, "chat.error", {
          requestId,
          error: "Unauthorized: Authentication required to query chat",
          statusCode: 401,
        });
        return;
      }

      const query = typeof chatPayload.query === "string" ? chatPayload.query.trim() : "";
      if (!query) {
        sendToClient(ws, "chat.error", {
          requestId,
          error: "Query is required and cannot be empty",
          statusCode: 400,
        });
        return;
      }

      const docId = chatPayload.documentId?.trim();
      if (docId && !UUID_REGEX.test(docId)) {
        sendToClient(ws, "chat.error", {
          requestId,
          error: "Invalid documentId format. Expected a valid UUID",
          statusCode: 400,
        });
        return;
      }

      const convId = chatPayload.conversationId?.trim();
      if (convId && !UUID_REGEX.test(convId)) {
        sendToClient(ws, "chat.error", {
          requestId,
          error: "Invalid conversationId format. Expected a valid UUID",
          statusCode: 400,
        });
        return;
      }

      let activeConversationId: string;
      let isNewConversation: boolean;
      let historyContext: Array<{ role: string; content: string }> = [];

      try {
        const prep = await prepareConversation(session.user.id, query, convId);
        if ("error" in prep) {
          sendToClient(ws, "chat.error", {
            requestId,
            error: "Conversation not found",
            statusCode: 404,
          });
          return;
        }
        activeConversationId = prep.data.conversationId;
        isNewConversation = prep.data.isNewConversation;
        historyContext = prep.data.historyContext;
      } catch {
        sendToClient(ws, "chat.error", {
          requestId,
          error: "Failed to prepare conversation session",
          statusCode: 500,
        });
        return;
      }

      sendToClient(ws, "chat.start", { requestId, conversationId: activeConversationId });

      const abortController = new AbortController();
      session.activeRequests.set(requestId, abortController);

      try {
        const routingOutcome = await routeChatQuery(query, { documentId: docId });

        let result: {
          answer: string;
          citations: Citation[];
          evidenceSufficient: boolean;
          refusalReason?: string | null;
          modelName: string;
          providerName: string;
          retrievalDebug?: RetrievalDebugInfo | undefined;
        };

        if (routingOutcome.handledDirectly && routingOutcome.result) {
          sendToClient(ws, "chat.token", { requestId, token: routingOutcome.result.answer });
          result = {
            ...routingOutcome.result,
            refusalReason: routingOutcome.result.refusalReason ?? null,
            retrievalDebug: {
              retrievedChunks: [],
              contextChunks: [],
              filterReason: `Bypassed retrieval via query router (${routingOutcome.decision.intent})`,
            },
          };
        } else {
          const streamResult = await generateAnswerStream(query, {
            documentId: docId,
            systemPrompt: chatPayload.systemPrompt?.trim(),
            conversationHistory: historyContext,
            signal: abortController.signal,
            onToken: (token: string) => {
              if (abortController.signal.aborted || ws.readyState !== WebSocket.OPEN) return;
              sendToClient(ws, "chat.token", { requestId, token });
            },
          });
          result = {
            ...streamResult,
            refusalReason: streamResult.refusalReason ?? null,
          };
        }

        if (abortController.signal.aborted) return;

        const persisted = await persistChatExchange(
          activeConversationId,
          session.user.id,
          query,
          result.answer,
          result.citations,
          isNewConversation
        );

        const isAuthorizedForDebug =
          session.user?.role === ROLE_NAMES.ADMIN ||
          session.user?.role === ROLE_NAMES.SUPER_ADMIN;

        const completePayload: Record<string, unknown> = {
          requestId,
          conversationId: persisted.finalConversationId,
          answer: result.answer,
          citations: result.citations,
          evidenceSufficient: result.evidenceSufficient,
          refusalReason: result.refusalReason ?? null,
          modelName: result.modelName,
          providerName: result.providerName,
          remainingMessages: persisted.remainingMessages,
          warning: persisted.warning,
          isNewConversation: persisted.isNewConversation,
        };

        if (isAuthorizedForDebug) {
          completePayload.retrievalDebug = result.retrievalDebug;
        }

        sendToClient(ws, "chat.complete", completePayload);
      } catch (err) {
        if (abortController.signal.aborted) {
          sendToClient(ws, "chat.error", { requestId, error: "Request cancelled", statusCode: 499 });
          return;
        }
        sendToClient(ws, "chat.error", {
          requestId,
          error: err instanceof Error ? err.message : "Failed to generate answer from documents",
          statusCode: 500,
        });
      } finally {
        session.activeRequests.delete(requestId);
      }
    }
  });

  ws.on("close", () => {
    for (const controller of session.activeRequests.values()) {
      controller.abort();
    }
    session.activeRequests.clear();
  });

  return session;
};
