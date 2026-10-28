import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { WebSocket } from "ws";
import { eq, inArray } from "drizzle-orm";
import app from "../src/app.js";
import { db, pool } from "../src/database/client.js";
import { users, roles, conversations, messages, ROLE_NAMES } from "../src/database/schema.js";
import { JWT_SECRET } from "../src/config/env.js";
import { initRealtimeServer, closeRealtimeServer, publishIngestionEvent } from "../src/realtime/index.js";

interface QueuedEvent {
  type: string;
  payload: Record<string, unknown>;
}

// Collector to buffer incoming WebSocket events and avoid dropped race conditions
const createEventCollector = (ws: WebSocket) => {
  const queue: QueuedEvent[] = [];
  const waiters: Array<{
    type: string;
    resolve: (val: QueuedEvent) => void;
    timer: NodeJS.Timeout;
  }> = [];

  ws.on("message", (raw) => {
    try {
      const parsed = JSON.parse(raw.toString()) as QueuedEvent;
      const waiterIdx = waiters.findIndex((w) => w.type === parsed.type);
      if (waiterIdx !== -1) {
        const [waiter] = waiters.splice(waiterIdx, 1);
        clearTimeout(waiter!.timer);
        waiter!.resolve(parsed);
      } else {
        queue.push(parsed);
      }
    } catch {}
  });

  return {
    waitFor(type: string, timeoutMs = 8000): Promise<QueuedEvent> {
      const queueIdx = queue.findIndex((e) => e.type === type);
      if (queueIdx !== -1) {
        const [event] = queue.splice(queueIdx, 1);
        return Promise.resolve(event!);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = waiters.findIndex((w) => w.timer === timer);
          if (idx !== -1) waiters.splice(idx, 1);
          reject(new Error(`Timeout waiting for event "${type}"`));
        }, timeoutMs);
        waiters.push({ type, resolve, timer });
      });
    },
  };
};

describe("WebSocket Chat Streaming (/ws)", () => {
  let server: http.Server;
  let wsUrl: string;

  const userAId = crypto.randomUUID();
  const userBId = crypto.randomUUID();
  const tokenA = jwt.sign({ sub: userAId, role: ROLE_NAMES.USER }, JWT_SECRET);
  const tokenB = jwt.sign({ sub: userBId, role: ROLE_NAMES.USER }, JWT_SECRET);
  const cleanupUserIds = [userAId, userBId];

  before(async () => {
    const [userRole] = await db
      .select({ id: roles.id })
      .from(roles)
      .where(eq(roles.name, ROLE_NAMES.USER))
      .limit(1);

    if (!userRole) {
      throw new Error("USER role not found in database seed");
    }

    await db.insert(users).values([
      {
        id: userAId,
        name: "WS Test User A",
        email: `ws-user-a-${Date.now()}@test.com`,
        passwordHash: "hashA",
        roleId: userRole.id,
      },
      {
        id: userBId,
        name: "WS Test User B",
        email: `ws-user-b-${Date.now()}@test.com`,
        passwordHash: "hashB",
        roleId: userRole.id,
      },
    ]);

    await new Promise<void>((resolve) => {
      server = http.createServer(app).listen(0, "127.0.0.1", () => {
        const addr = server.address() as { port: number };
        initRealtimeServer(server, "/ws");
        wsUrl = `ws://127.0.0.1:${addr.port}/ws`;
        resolve();
      });
    });
  });

  after(async () => {
    await closeRealtimeServer();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });

    const userConvs = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(inArray(conversations.userId, cleanupUserIds));

    if (userConvs.length > 0) {
      const convIds = userConvs.map((c) => c.id);
      await db.delete(messages).where(inArray(messages.conversationId, convIds));
      await db.delete(conversations).where(inArray(conversations.id, convIds));
    }

    await db.delete(users).where(inArray(users.id, cleanupUserIds));
    await pool.end();
  });

  it("1. should receive connection.connected handshake upon connecting", async () => {
    const ws = new WebSocket(wsUrl);
    const collector = createEventCollector(ws);
    const event = await collector.waitFor("connection.connected");

    assert.equal(event.type, "connection.connected");
    assert.ok(event.payload.message);
    ws.close();
  });

  it("2. should reject chat.send with 401 when unauthenticated", async () => {
    const ws = new WebSocket(wsUrl);
    const collector = createEventCollector(ws);
    await collector.waitFor("connection.connected");

    ws.send(JSON.stringify({ type: "chat.send", payload: { query: "What is this?" } }));
    const errEvent = await collector.waitFor("chat.error");

    assert.equal(errEvent.payload.statusCode, 401);
    assert.ok(String(errEvent.payload.error).includes("Authentication required"));
    ws.close();
  });

  it("3. should authenticate via { type: 'auth', payload: { token } } message", async () => {
    const ws = new WebSocket(wsUrl);
    const collector = createEventCollector(ws);
    await collector.waitFor("connection.connected");

    ws.send(JSON.stringify({ type: "auth", payload: { token: tokenA } }));
    const authSuccess = await collector.waitFor("auth.success");

    assert.equal(authSuccess.payload.userId, userAId);
    assert.equal(authSuccess.payload.role, ROLE_NAMES.USER);
    ws.close();
  });

  it("4. should authenticate via query param ws://.../ws?token=...", async () => {
    const ws = new WebSocket(`${wsUrl}?token=${tokenA}`);
    const collector = createEventCollector(ws);
    await collector.waitFor("connection.connected");

    // Empty query should be rejected with 400 (not 401), proving user is authenticated
    ws.send(JSON.stringify({ type: "chat.send", payload: { query: "" } }));
    const errEvent = await collector.waitFor("chat.error");

    assert.equal(errEvent.payload.statusCode, 400);
    assert.ok(String(errEvent.payload.error).includes("Query is required and cannot be empty"));
    ws.close();
  });

  it("5. should validate conversationId UUID format", async () => {
    const ws = new WebSocket(`${wsUrl}?token=${tokenA}`);
    const collector = createEventCollector(ws);
    await collector.waitFor("connection.connected");

    ws.send(
      JSON.stringify({
        type: "chat.send",
        payload: { query: "Hello", conversationId: "not-a-uuid" },
      })
    );
    const errEvent = await collector.waitFor("chat.error");

    assert.equal(errEvent.payload.statusCode, 400);
    assert.ok(String(errEvent.payload.error).includes("Invalid conversationId format"));
    ws.close();
  });

  it("6. should return 404 if conversation does not exist", async () => {
    const ws = new WebSocket(`${wsUrl}?token=${tokenA}`);
    const collector = createEventCollector(ws);
    await collector.waitFor("connection.connected");

    const fakeConvId = crypto.randomUUID();
    ws.send(
      JSON.stringify({
        type: "chat.send",
        payload: { query: "Hello", conversationId: fakeConvId },
      })
    );
    const errEvent = await collector.waitFor("chat.error");

    assert.equal(errEvent.payload.statusCode, 404);
    assert.ok(String(errEvent.payload.error).includes("Conversation not found"));
    ws.close();
  });

  // Test cases 7 & 8 involve live external LLM/embedding API network latency; skipped per user instruction to finish quickly
  it.skip("7. should stream chat tokens and complete when evidence is insufficient", async () => {
    const ws = new WebSocket(`${wsUrl}?token=${tokenA}`);
    const collector = createEventCollector(ws);
    await collector.waitFor("connection.connected");

    const requestId = "req-test-insuff-1";
    ws.send(
      JSON.stringify({
        type: "chat.send",
        payload: { query: "Unique query without any matching document in DB", requestId },
      })
    );

    const startEvent = await collector.waitFor("chat.start");
    assert.equal(startEvent.payload.requestId, requestId);
    assert.ok(startEvent.payload.conversationId);

    const tokenEvent = await collector.waitFor("chat.token");
    assert.equal(tokenEvent.payload.requestId, requestId);
    assert.ok(tokenEvent.payload.token);

    const completeEvent = await collector.waitFor("chat.complete");
    assert.equal(completeEvent.payload.requestId, requestId);
    assert.equal(completeEvent.payload.evidenceSufficient, false);
    assert.ok(completeEvent.payload.answer);

    // Verify exchange was persisted in DB
    const savedMessages = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, String(completeEvent.payload.conversationId)));
    assert.equal(savedMessages.length, 2);
    assert.equal(savedMessages[0]?.role, "user");
    assert.equal(savedMessages[1]?.role, "assistant");

    ws.close();
  });

  it.skip("8. should isolate chat events between multiple concurrent clients", async () => {
    const wsA = new WebSocket(`${wsUrl}?token=${tokenA}`);
    const wsB = new WebSocket(`${wsUrl}?token=${tokenB}`);

    const collectorA = createEventCollector(wsA);
    const collectorB = createEventCollector(wsB);

    await Promise.all([
      collectorA.waitFor("connection.connected"),
      collectorB.waitFor("connection.connected"),
    ]);

    let receivedByB = false;
    wsB.on("message", (raw) => {
      const parsed = JSON.parse(raw.toString()) as { type: string };
      if (parsed.type.startsWith("chat.")) {
        receivedByB = true;
      }
    });

    const reqAId = "client-a-request";
    wsA.send(
      JSON.stringify({
        type: "chat.send",
        payload: { query: "Client A private question", requestId: reqAId },
      })
    );

    const completeA = await collectorA.waitFor("chat.complete");
    assert.equal(completeA.payload.requestId, reqAId);

    // Small delay to verify no cross-client leakage
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(receivedByB, false, "Client B must NOT receive any chat events sent to Client A");

    wsA.close();
    wsB.close();
  });

  it("9. should preserve document ingestion event broadcasting to all connected clients", async () => {
    const wsA = new WebSocket(`${wsUrl}?token=${tokenA}`);
    const wsB = new WebSocket(`${wsUrl}?token=${tokenB}`);

    const collectorA = createEventCollector(wsA);
    const collectorB = createEventCollector(wsB);

    await Promise.all([
      collectorA.waitFor("connection.connected"),
      collectorB.waitFor("connection.connected"),
    ]);

    const waitDocA = collectorA.waitFor("document.processing");
    const waitDocB = collectorB.waitFor("document.processing");

    publishIngestionEvent("document.processing", {
      documentId: "doc-broadcast-test",
      filename: "sample.pdf",
    });

    const [docA, docB] = await Promise.all([waitDocA, waitDocB]);
    assert.equal(docA.payload.documentId, "doc-broadcast-test");
    assert.equal(docB.payload.documentId, "doc-broadcast-test");

    wsA.close();
    wsB.close();
  });

  it("10. should immediately stream greeting via WebSocket router gate without invoking LLM", async () => {
    const ws = new WebSocket(`${wsUrl}?token=${tokenA}`);
    const collector = createEventCollector(ws);
    await collector.waitFor("connection.connected");

    const requestId = crypto.randomUUID();
    ws.send(JSON.stringify({ type: "chat.send", payload: { query: "Hello there!", requestId } }));

    const startEvent = await collector.waitFor("chat.start");
    assert.equal(startEvent.payload.requestId, requestId);

    const tokenEvent = await collector.waitFor("chat.token");
    assert.equal(tokenEvent.payload.requestId, requestId);
    assert.ok(String(tokenEvent.payload.token).includes("Hello!"));

    const completeEvent = await collector.waitFor("chat.complete");
    assert.equal(completeEvent.payload.requestId, requestId);
    assert.equal(completeEvent.payload.modelName, "conversational");
    assert.equal(completeEvent.payload.evidenceSufficient, true);

    ws.close();
  });
});
