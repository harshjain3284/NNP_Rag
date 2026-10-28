import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { eq, inArray } from "drizzle-orm";
import app from "../src/app.js";
import { db, pool } from "../src/database/client.js";
import {
  users,
  roles,
  conversations,
  messages,
  ROLE_NAMES,
} from "../src/database/schema.js";
import { JWT_SECRET } from "../src/config/env.js";
import { chunkRetriever } from "../src/rag/retrieval/retriever.js";
import {
  GREETING_RESPONSE,
  OUT_OF_SCOPE_REFUSAL_MESSAGE,
  OUT_OF_SCOPE_REFUSAL_REASON,
  getActiveOKFBundle,
} from "../src/rag/okf/service.js";

describe("Milestone 2: Query Flow Integration & Pre-Retrieval Router (/api/chat)", () => {
  let server: http.Server;
  let baseUrl: string;

  const userAId = crypto.randomUUID();
  const userBId = crypto.randomUUID();
  const adminId = crypto.randomUUID();

  const userAEmail = `user-a-${Date.now()}@test.com`;
  const userBEmail = `user-b-${Date.now()}@test.com`;
  const adminEmail = `admin-${Date.now()}@test.com`;

  const tokenUserA = jwt.sign(
    { sub: userAId, role: ROLE_NAMES.USER },
    JWT_SECRET
  );
  const tokenUserB = jwt.sign(
    { sub: userBId, role: ROLE_NAMES.USER },
    JWT_SECRET
  );
  const tokenAdmin = jwt.sign(
    { sub: adminId, role: ROLE_NAMES.ADMIN },
    JWT_SECRET
  );

  const cleanupUserIds = [userAId, userBId, adminId];

  // Spies to track pgvector chunk retrieval invocations
  let retrievalInvocationCount = 0;
  const originalRetrieveChunksWithDebug = chunkRetriever.retrieveChunksWithDebug;

  before(async () => {
    // 1. Fetch role IDs
    const allRoles = await db.select().from(roles);
    const userRole = allRoles.find((r) => r.name === ROLE_NAMES.USER);
    const adminRole = allRoles.find((r) => r.name === ROLE_NAMES.ADMIN);

    if (!userRole || !adminRole) {
      throw new Error("Required roles not found in database seed");
    }

    // 2. Insert test users
    await db.insert(users).values([
      {
        id: userAId,
        name: "Router Test User A",
        email: userAEmail,
        passwordHash: "hashA",
        roleId: userRole.id,
      },
      {
        id: userBId,
        name: "Router Test User B",
        email: userBEmail,
        passwordHash: "hashB",
        roleId: userRole.id,
      },
      {
        id: adminId,
        name: "Router Test Admin",
        email: adminEmail,
        passwordHash: "hashAdmin",
        roleId: adminRole.id,
      },
    ]);

    // 3. Attach retrieval spy
    chunkRetriever.retrieveChunksWithDebug = async (...args) => {
      retrievalInvocationCount++;
      return originalRetrieveChunksWithDebug.apply(chunkRetriever, args);
    };

    // 4. Start HTTP test server
    await new Promise<void>((resolve) => {
      server = http.createServer(app).listen(0, "127.0.0.1", () => {
        const addr = server.address() as { port: number };
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  after(async () => {
    // Restore spy
    chunkRetriever.retrieveChunksWithDebug = originalRetrieveChunksWithDebug;

    // Close server
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });

    // Cleanup conversations and test users
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

  describe("1. Greeting Route (`greeting`)", () => {
    it("should return a conversational response and bypass vector retrieval", async () => {
      retrievalInvocationCount = 0;

      const res = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${tokenUserA}`,
        },
        body: JSON.stringify({ query: "Hello there!" }),
      });

      assert.equal(res.status, 200);
      const data = (await res.json()) as {
        conversationId: string;
        answer: string;
        evidenceSufficient: boolean;
        citations: unknown[];
        modelName: string;
        providerName: string;
      };

      // Assert retrieval was completely bypassed
      assert.equal(retrievalInvocationCount, 0, "Vector retrieval must not be invoked for greetings");

      // Assert response format and values
      assert.equal(data.evidenceSufficient, true);
      assert.deepEqual(data.citations, []);
      assert.equal(data.modelName, "conversational");
      assert.equal(data.providerName, "system");
      assert.equal(data.answer, GREETING_RESPONSE);
      assert.ok(data.conversationId, "Should return an active conversation ID");

      // Verify conversation and message persistence in PostgreSQL
      const persistedMessages = await db
        .select()
        .from(messages)
        .where(eq(messages.conversationId, data.conversationId));

      assert.equal(persistedMessages.length, 2, "User and assistant messages must be persisted");
      assert.equal(persistedMessages[0]?.role, "user");
      assert.equal(persistedMessages[0]?.content, "Hello there!");
      assert.equal(persistedMessages[1]?.role, "assistant");
      assert.equal(persistedMessages[1]?.content, GREETING_RESPONSE);
    });
  });

  describe("2. OKF Topic Route (`okf_topic`)", () => {
    it("should resolve concept content and return citations without vector retrieval", async () => {
      retrievalInvocationCount = 0;

      const res = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${tokenUserA}`,
        },
        body: JSON.stringify({ query: "How does the RAG pipeline execution flow work?" }),
      });

      assert.equal(res.status, 200);
      const data = (await res.json()) as {
        conversationId: string;
        answer: string;
        evidenceSufficient: boolean;
        citations: Array<{
          documentId: string;
          filename: string;
          chunkId: string;
          similarity: number;
          snippet: string;
        }>;
        modelName: string;
        providerName: string;
      };

      // Assert vector retrieval was completely bypassed
      assert.equal(retrievalInvocationCount, 0, "Vector retrieval must not be invoked for OKF topics");

      // Assert answer is grounded in loaded OKF concept
      assert.equal(data.evidenceSufficient, true);
      assert.equal(data.modelName, "okf-direct");
      assert.equal(data.providerName, "okf-bundle");
      assert.ok(data.answer.includes("RAG Pipeline Execution Flow"));
      assert.ok(data.answer.includes("LlamaParse"));

      // Assert citation structure
      assert.equal(data.citations.length, 1);
      assert.equal(data.citations[0]?.documentId, "okf-bundle");
      assert.equal(data.citations[0]?.filename, "architecture/pipeline.md");
      assert.equal(data.citations[0]?.chunkId, "okf:architecture/pipeline");
      assert.equal(data.citations[0]?.similarity, 1.0);
      assert.ok(data.citations[0]?.snippet.length > 0);

      // Verify persistence in PostgreSQL with citation metadata
      const persistedMessages = await db
        .select()
        .from(messages)
        .where(eq(messages.conversationId, data.conversationId));

      assert.equal(persistedMessages.length, 2);
      const assistantMsg = persistedMessages.find((m) => m.role === "assistant");
      assert.ok(assistantMsg);
      assert.ok(Array.isArray(assistantMsg.citations));
      assert.equal((assistantMsg.citations as unknown[]).length, 1);
    });

    it("should resolve supported formats query via OKF bundle without vector retrieval", async () => {
      retrievalInvocationCount = 0;

      const res = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${tokenUserA}`,
        },
        body: JSON.stringify({ query: "What file formats can I upload?" }),
      });

      assert.equal(res.status, 200);
      const data = (await res.json()) as {
        answer: string;
        evidenceSufficient: boolean;
        citations: Array<{ filename: string; similarity: number }>;
      };

      assert.equal(retrievalInvocationCount, 0, "Vector retrieval must not be invoked");
      assert.equal(data.evidenceSufficient, true);
      assert.ok(data.answer.includes("Supported Ingestion Formats"));
      assert.ok(data.answer.includes(".pdf"));
      assert.ok(data.answer.includes("25 MB"));
      assert.equal(data.citations[0]?.filename, "capabilities/supported_formats.md");
    });
  });

  describe("3. Out of Scope Route (`out_of_scope`)", () => {
    it("should return established polite refusal without retrieval or unrestricted generation", async () => {
      retrievalInvocationCount = 0;

      const res = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${tokenUserA}`,
        },
        body: JSON.stringify({ query: "Who won the FIFA World Cup?" }),
      });

      assert.equal(res.status, 200);
      const data = (await res.json()) as {
        answer: string;
        evidenceSufficient: boolean;
        refusalReason: string;
        citations: unknown[];
        modelName: string;
        providerName: string;
      };

      // Assert retrieval was completely bypassed
      assert.equal(retrievalInvocationCount, 0, "Vector retrieval must not be invoked for out-of-scope queries");

      assert.equal(data.evidenceSufficient, false);
      assert.equal(data.refusalReason, OUT_OF_SCOPE_REFUSAL_REASON);
      assert.equal(data.answer, OUT_OF_SCOPE_REFUSAL_MESSAGE);
      assert.deepEqual(data.citations, []);
      assert.equal(data.modelName, "system");
      assert.equal(data.providerName, "system");
    });
  });

  describe("4. Document RAG Route (`document_rag`)", () => {
    it("should invoke vector retrieval and the existing RAG pipeline for document queries", async () => {
      retrievalInvocationCount = 0;

      const res = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${tokenUserA}`,
        },
        body: JSON.stringify({ query: "According to the uploaded document, what are the contractual liabilities?" }),
      });

      assert.equal(res.status, 200);
      const data = (await res.json()) as {
        answer: string;
        evidenceSufficient: boolean;
        citations: unknown[];
      };

      // Assert retrieval was invoked
      assert.ok(
        retrievalInvocationCount >= 1,
        "Vector retrieval MUST be invoked for document queries"
      );
      assert.ok(typeof data.answer === "string");
      assert.ok(Array.isArray(data.citations));
    });

    it("should route to document RAG when an explicit documentId is provided, even with an OKF-sounding query", async () => {
      retrievalInvocationCount = 0;
      const targetDocId = crypto.randomUUID();

      const res = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${tokenUserA}`,
        },
        body: JSON.stringify({
          query: "What is the pipeline flow?",
          documentId: targetDocId,
        }),
      });

      assert.equal(res.status, 200);

      // Explicit documentId MUST enforce document retrieval rather than bypassing to OKF
      assert.ok(
        retrievalInvocationCount >= 1,
        "Vector retrieval MUST be invoked when documentId is explicitly targeted"
      );
    });
  });

  describe("5. Ambiguous & Mixed Queries (`ambiguous_mixed`)", () => {
    it("should resolve greeting mixed with OKF topic without vector retrieval", async () => {
      retrievalInvocationCount = 0;

      const res = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${tokenUserA}`,
        },
        body: JSON.stringify({ query: "Hello, what file formats can I upload?" }),
      });

      assert.equal(res.status, 200);
      const data = (await res.json()) as {
        answer: string;
        evidenceSufficient: boolean;
        citations: Array<{ filename: string }>;
      };

      assert.equal(retrievalInvocationCount, 0, "Mixed OKF queries should resolve via OKF bundle without retrieval");
      assert.equal(data.evidenceSufficient, true);
      assert.ok(data.answer.includes("Supported Ingestion Formats"));
      assert.equal(data.citations[0]?.filename, "capabilities/supported_formats.md");
    });

    it("should NOT skip necessary document retrieval when greeting is mixed with document intent", async () => {
      retrievalInvocationCount = 0;

      const res = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${tokenUserA}`,
        },
        body: JSON.stringify({ query: "Hello, what does the report state on page 4?" }),
      });

      assert.equal(res.status, 200);

      // Document intent must invoke vector retrieval
      assert.ok(
        retrievalInvocationCount >= 1,
        "Vector retrieval MUST be invoked when query contains document intent"
      );
    });
  });

  describe("6. Multi-Turn Conversation History & Persistence Across Routes", () => {
    it("should maintain conversation history across diverse routed turns (greeting -> OKF -> out-of-scope)", async () => {
      // Turn 1: Greeting
      const res1 = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${tokenUserA}`,
        },
        body: JSON.stringify({ query: "Hi" }),
      });
      assert.equal(res1.status, 200);
      const data1 = (await res1.json()) as { conversationId: string };
      const conversationId = data1.conversationId;
      assert.ok(conversationId);

      // Turn 2: OKF Topic in same conversation
      const res2 = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${tokenUserA}`,
        },
        body: JSON.stringify({
          conversationId,
          query: "What file formats can I upload?",
        }),
      });
      assert.equal(res2.status, 200);
      const data2 = (await res2.json()) as { conversationId: string };
      assert.equal(data2.conversationId, conversationId);

      // Turn 3: Out-of-scope in same conversation
      const res3 = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${tokenUserA}`,
        },
        body: JSON.stringify({
          conversationId,
          query: "Tell me a funny joke",
        }),
      });
      assert.equal(res3.status, 200);
      const data3 = (await res3.json()) as { conversationId: string };
      assert.equal(data3.conversationId, conversationId);

      // Verify all 3 exchanges (6 messages total) exist in PostgreSQL
      const convMsgs = await db
        .select()
        .from(messages)
        .where(eq(messages.conversationId, conversationId));

      assert.equal(convMsgs.length, 6, "All 6 messages must be stored in database");
    });
  });

  describe("7. Authorization, User Isolation & Error Handling", () => {
    it("should return 401 when Authorization header is absent", async () => {
      const res = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "Hello" }),
      });
      assert.equal(res.status, 401);
    });

    it("should block User B from appending to User A's conversation", async () => {
      // User A creates conversation
      const resA = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${tokenUserA}`,
        },
        body: JSON.stringify({ query: "Hello from User A" }),
      });
      const dataA = (await resA.json()) as { conversationId: string };

      // User B tries to send message into User A's conversation
      const resB = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${tokenUserB}`,
        },
        body: JSON.stringify({
          conversationId: dataA.conversationId,
          query: "What file formats can I upload?",
        }),
      });
      assert.equal(resB.status, 404, "Must not leak or allow access to another user's conversation");
    });

    it("should expose retrievalDebug to ADMIN role and suppress it for regular USER", async () => {
      // Admin request
      const adminRes = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${tokenAdmin}`,
        },
        body: JSON.stringify({ query: "Hello" }),
      });
      assert.equal(adminRes.status, 200);
      const adminData = (await adminRes.json()) as { retrievalDebug?: unknown };
      assert.ok(adminData.retrievalDebug !== undefined, "ADMIN should receive retrievalDebug");

      // Regular User request
      const userRes = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${tokenUserA}`,
        },
        body: JSON.stringify({ query: "Hello" }),
      });
      assert.equal(userRes.status, 200);
      const userData = (await userRes.json()) as { retrievalDebug?: unknown };
      assert.equal(userData.retrievalDebug, undefined, "USER should NOT receive retrievalDebug");
    });
  });
});
