import { request } from "./client";
import type {
  ChatRequest,
  ChatResponse,
  ChatSendPayload,
  ChatStartPayload,
  ChatTokenPayload,
  ChatCompletePayload,
  ChatErrorPayload,
} from "@/types";

export interface StreamChatCallbacks {
  onStart?: (payload: ChatStartPayload) => void;
  onToken?: (token: string, payload: ChatTokenPayload) => void;
  onComplete?: (payload: ChatCompletePayload) => void;
  onError?: (error: string, payload?: ChatErrorPayload) => void;
}

export interface StreamChatOptions {
  token?: string | null;
  conversationId?: string;
  documentId?: string;
  systemPrompt?: string;
  requestId?: string;
}

export interface ActiveChatStream {
  cancel: () => void;
  close: () => void;
}

let activeSocket: WebSocket | null = null;
let currentSocketToken: string | null | undefined = undefined;

export function getWsUrl(token?: string | null): string {
  const configured = process.env.NEXT_PUBLIC_WS_URL;
  const base = configured || "ws://localhost:3000/ws";
  return token ? `${base}?token=${encodeURIComponent(token)}` : base;
}

export function closeChatSocket(): void {
  if (activeSocket) {
    activeSocket.close();
    activeSocket = null;
    currentSocketToken = undefined;
  }
}

export function getChatSocket(token?: string | null): Promise<WebSocket> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("WebSocket not supported on server"));
  }

  if (activeSocket && currentSocketToken !== token) {
    closeChatSocket();
  }

  if (activeSocket && activeSocket.readyState === WebSocket.OPEN) {
    return Promise.resolve(activeSocket);
  }

  if (activeSocket && activeSocket.readyState === WebSocket.CONNECTING) {
    return new Promise((resolve, reject) => {
      const socket = activeSocket!;
      const onOpen = () => {
        cleanup();
        resolve(socket);
      };
      const onError = () => {
        cleanup();
        reject(new Error("WebSocket connection failed"));
      };
      const cleanup = () => {
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("error", onError);
      };
      socket.addEventListener("open", onOpen);
      socket.addEventListener("error", onError);
    });
  }

  return new Promise((resolve, reject) => {
    try {
      const url = getWsUrl(token);
      const socket = new WebSocket(url);
      activeSocket = socket;
      currentSocketToken = token;

      const onOpen = () => {
        cleanup();
        resolve(socket);
      };
      const onError = () => {
        cleanup();
        reject(new Error("WebSocket connection failed"));
      };
      const cleanup = () => {
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("error", onError);
      };

      socket.addEventListener("open", onOpen);
      socket.addEventListener("error", onError);

      socket.onclose = () => {
        if (activeSocket === socket) {
          activeSocket = null;
          currentSocketToken = undefined;
        }
      };
    } catch (err) {
      reject(err);
    }
  });
}

export async function streamChatQuery(
  query: string,
  options: StreamChatOptions,
  callbacks: StreamChatCallbacks
): Promise<ActiveChatStream> {
  const socket = await getChatSocket(options.token);
  const requestId =
    options.requestId ||
    (typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : `req-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`);

  const messageHandler = (event: MessageEvent) => {
    if (typeof event.data !== "string") return;
    let parsed: { type?: string; payload?: Record<string, unknown> };
    try {
      parsed = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!parsed || !parsed.type) return;

    const { type, payload = {} } = parsed;

    if (type === "chat.start") {
      const start = payload as unknown as ChatStartPayload;
      if (start.requestId === requestId) {
        callbacks.onStart?.(start);
      }
    } else if (type === "chat.token") {
      const tokenPayload = payload as unknown as ChatTokenPayload;
      if (tokenPayload.requestId === requestId && tokenPayload.token) {
        callbacks.onToken?.(tokenPayload.token, tokenPayload);
      }
    } else if (type === "chat.complete") {
      const comp = payload as unknown as ChatCompletePayload;
      if (comp.requestId === requestId) {
        cleanup();
        callbacks.onComplete?.(comp);
      }
    } else if (type === "chat.error") {
      const err = payload as unknown as ChatErrorPayload;
      if (!err.requestId || err.requestId === requestId) {
        cleanup();
        callbacks.onError?.(err.error || "Failed to generate answer", err);
      }
    }
  };

  const cleanup = () => {
    socket.removeEventListener("message", messageHandler);
  };

  socket.addEventListener("message", messageHandler);

  const payload: ChatSendPayload = {
    query,
    conversationId: options.conversationId,
    documentId: options.documentId,
    systemPrompt: options.systemPrompt,
    requestId,
    token: options.token || undefined,
  };

  socket.send(JSON.stringify({ type: "chat.send", payload }));

  return {
    cancel: () => {
      cleanup();
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "chat.cancel", payload: { requestId } }));
      }
    },
    close: cleanup,
  };
}

export async function sendChatQuery(
  payload: ChatRequest,
  token?: string | null
): Promise<ChatResponse> {
  return request<ChatResponse>("/api/chat", {
    method: "POST",
    body: JSON.stringify(payload),
    token,
  });
}

