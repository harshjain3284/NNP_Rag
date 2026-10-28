# NNT RAG — Project Blueprint

> **Project Status:** Phase 1 Complete — Full Stack Document Q&A, Admin & User Management, Configuration, and Real-Time Frontend UI  
> **Source of Truth:** Authoritative architectural specification, technology selections, data contracts, and scope boundaries for NNT RAG. All implementations, modifications, and AI agent contributions must strictly conform to this document.

---

# 1. Project Overview and Core Principles

**NNT RAG** is a production-oriented document question-answering system built on Retrieval-Augmented Generation (RAG). The system enables authorized administrators to ingest multi-format documents and configure system prompts, allowing authenticated users to query document knowledge and receive grounded answers supported by verifiable citations.

### 1.1 Core RAG Principle
> **The system answers questions strictly and exclusively using authorized knowledge from uploaded documents and administrator-managed prompts.**

The application enforces strict grounding safeguards to minimize hallucination risks by constraining model responses to retrieved evidence. If sufficient evidence cannot be found within the authorized document chunks, the system is designed to explicitly refuse to answer and provide a clear explanation.

```text
User Question
      ↓
Semantic Retrieval (PostgreSQL pgvector)
      ↓
Evidence Sufficiency Gate
      │
      ├─ [Insufficient: Top score < 0.65 OR 0 chunks] ──→ Structured Refusal Response
      │
      ↓ [Sufficient]
Prompt Context Construction ([Source 1], [Source 2] ...)
      ↓
LLM Provider Execution (Groq / Gemini / Ollama)
      │
      ├─ [Model Refusal Sentinel: INSUFFICIENT_EVIDENCE] ──→ Structured Refusal Response
      │
      ↓ [Grounded Answer]
Source Citation Extraction & Mapping ──→ Final Answer + Citations
```

### 1.2 System Personas and User Journeys
1. **End User:** Authenticates, browses accessible knowledge documents, asks natural language questions, views grounded answers with page-level citations, and maintains multi-turn conversation threads.
2. **Administrator:** Uploads documents (PDF, TXT, DOCX), monitors real-time ingestion telemetry via WebSockets, deletes obsolete documents, and configures prompt templates.
3. **Super Administrator:** Manages administrative users, system-wide configuration parameters, and provider settings.

---

# 2. Phase 1 Scope, User Roles, and Permissions

## 2.1 Included in Phase 1
Phase 1 delivers the foundational RAG pipeline alongside authentication, chat persistence, prompt management, and frontend UI:
* **Document Ingestion [Implemented]:** Multi-format file upload (PDF, TXT, DOCX), SHA-256 deduplication hashing, layout parsing via LlamaParse, structural Markdown chunking, and local filesystem storage.
* **Vector Pipeline [Implemented]:** Local in-process embedding (`jina-embeddings-v2-small-en`, 512 dimensions) via Transformers.js, persistent storage in Supabase PostgreSQL (`pgvector`).
* **Semantic Retrieval [Implemented]:** Cosine similarity retrieval (`<=>`) on ready document chunks using `PGVectorRetriever`.
* **Real-Time Visibility & Chat Streaming [Implemented]:** WebSocket server (`/ws`) providing real-time chat streaming (`chat.start`, `chat.token`, `chat.complete`, `chat.error`) with per-client JWT authentication and active conversation tracking, alongside broadcast document ingestion lifecycle events.
* **User Authentication & RBAC [Implemented]:** User registration, login, profile management, password updates, stateless JWT issuance, and server-side role enforcement.
* **Chat & History [Implemented]:** Multi-turn conversation threads, message persistence, citation linkage, 50-message limit with rollover, conversation deletion with cascade cleanup, and conversation REST APIs alongside real-time WebSocket chat streaming.
* **Prompt Management [Implemented]:** Database-backed prompt storage, administrative CRUD endpoints, and dynamic RAG generator integration.
* **Frontend Web Application [Implemented - Milestone 3]:** Complete Next.js App Router UI featuring responsive ChatGPT dark theme, real-time WebSocket document ingestion progress, conversational Q&A with Source Inspector drawer, prompt management, Super Admin user & runtime configuration consoles, user profile editing, account settings, and accessible logout confirmation.

## 2.2 Excluded from Phase 1
The following are intentionally excluded to maintain architectural simplicity: microservices, Kubernetes, Kafka, Redis/caching, standalone vector databases (Pinecone/Milvus), cloud object storage (S3), OCR scanning for handwritten documents, hybrid BM25 search, cross-encoder reranking, query rewriting, and enterprise SSO.

## 2.3 User Roles & Permissions Matrix
The backend serves as the sole security boundary; permissions are enforced via server-side RBAC middleware:

| **Role** | **Scope & Permissions** | **Protected Operations** |
| :--- | :--- | :--- |
| **USER** | Standard consumer of document knowledge. Can authenticate, list accessible documents, execute queries, view grounded answers with citations, and manage personal conversation history. | Cannot upload/modify documents, cannot alter prompts, cannot access administrative endpoints. |
| **ADMIN** | Knowledge and prompt administrator. Inherits all User permissions. Can upload documents (up to 10 active documents per admin), trigger processing, delete owned documents, manage prompts, and view ingestion telemetry. | Document upload/deletion (`/api/documents`), prompt CRUD (`/api/prompts`), ingestion monitoring. |
| **SUPER_ADMIN** | System administrator. Inherits all Admin permissions. Can manage all documents across the system, manage user accounts, assign roles, configure global prompts, and adjust provider configurations. | Document deletion across any admin, user role modification, system-level configurations, administrative user provisioning. |

---

# 3. System Architecture and Folder Responsibilities

NNT RAG consists of two decoupled applications: a Next.js frontend and an Express.js backend communicating via HTTP REST and WebSockets.

```text
NNT_Rag/
├── frontend/                     # Next.js App Router, React, TypeScript, Tailwind CSS
│   ├── src/
│   │   ├── app/                  # Routes: layout.tsx, page.tsx, /chat, /documents, /admin
│   │   ├── components/           # UI components (chat, document upload, citation cards)
│   │   │   ├── ui/               # Base UI primitives (buttons, inputs, modals, alerts)
│   │   │   ├── chat/             # Chat thread, message list, citation popovers
│   │   │   ├── documents/        # File dropzone, upload progress table, status badges
│   │   │   └── admin/            # Prompt editor, user management table
│   │   ├── lib/                  # API client, auth utilities, formatting helpers
│   │   ├── hooks/                # Custom React hooks (useWebSocket, useChat, useAuth)
│   │   └── types/                # Frontend TypeScript contracts
├── knowledge/                    # OKF v0.2 Knowledge Bundles
│   └── bundle/                   # Hierarchical topic maps, root index.md, and update log.md
│
├── backend/                      # Node.js, Express, TypeScript, Drizzle ORM, pgvector
│   ├── uploads/                  # Phase 1 local filesystem storage for uploaded files
│   ├── src/
│   │   ├── server.ts             # HTTP server entrypoint & WebSocket server attachment
│   │   ├── app.ts                # Express application configuration & route mounting
│   │   ├── config/               # Environment variables (env.ts) and RAG defaults (rag.ts)
│   │   ├── database/             # Drizzle connection (client.ts) and schema (schema.ts)
│   │   ├── routes/               # Route declarations (/documents, /chat, /auth, /prompts)
│   │   ├── controllers/          # HTTP request handlers & response orchestration
│   │   ├── services/             # Core business logic (document.service.ts, chat.service.ts)
│   │   ├── middleware/           # Auth (JWT), RBAC role validation, error handling
│   │   ├── validators/           # Zod runtime request schemas
│   │   ├── providers/            # Vendor-agnostic model adapters
│   │   │   ├── embeddings/       # Local Transformers.js embedding provider & contracts
│   │   │   └── llm/              # Groq, Gemini, and Ollama provider implementations
│   │   ├── rag/                  # Modular RAG pipeline layers
│   │   │   ├── ingestion/        # Parser, cleaner, chunker, queue, pipeline, persistence
│   │   │   ├── retrieval/        # PGVectorRetriever (cosine similarity search)
│   │   │   ├── generation/       # Prompt builder, sufficiency gates, citation extractor
│   │   │   └── okf/              # OKF v0.2 parser, validator, loader, and query router
│   │   ├── realtime/             # WebSocket server and typed ingestion lifecycle events
│   │   ├── types/                # Shared backend interfaces
│   │   └── utils/                # Helper utilities (hash computation, file management)
│   └── package.json
└── project_blueprint.md          # Authoritative system blueprint
```

### 3.1 Backend Module Ownership Breakdown
* **`config/` [Implemented]:** Centralizes environment configuration parsing (`env.ts`) and RAG hyperparameters (`rag.ts`). No process variables are read outside this module.
* **`database/` [Implemented]:** Owns the Drizzle ORM client, connection pooling to Supabase PostgreSQL, and declarative table schema definitions (`schema.ts`).
* **`routes/` [Implemented]:** Thin HTTP routing layer (`documents.routes.ts`, `chat.routes.ts`, `conversation.routes.ts`, `auth.routes.ts`, `admin.routes.ts`, `prompts.routes.ts`).
* **`controllers/` [Implemented]:** Extracts request parameters, handles HTTP status codes, and delegates execution to services (`documents.controller.ts`, `chat.controller.ts`, `conversation.controller.ts`, `auth.controller.ts`, `admin.controller.ts`, `prompts.controller.ts`).
* **`services/` [Implemented]:** Implements core business logic, transactional database persistence, and orchestration (`document.service.ts`, `conversation.service.ts`, `auth.service.ts`, `admin.service.ts`, `prompts.service.ts`).
* **`middleware/`:** Houses upload handling (`upload.middleware.ts` [implemented]), authentication guard (`auth.middleware.ts` [implemented]), role checking (`role.middleware.ts` [implemented]), and planned centralized error handling (`error.middleware.ts`).
* **`validators/` [Planned]:** Zod schemas validating HTTP request bodies, query strings, and path parameters before execution.
* **`providers/` [Implemented]:** Vendor-agnostic abstractions isolating LLM generation and embedding models behind clean contracts.
* **`rag/` [Implemented]:** Houses the ingestion, retrieval, and generation engines implementing core RAG capabilities. Includes `rag/okf/` (implemented in Milestone 1) owning OKF v0.2 concept parsing, YAML frontmatter extraction, conformance validation, trust-tier derivation, bundle loading, and pre-retrieval query routing contracts.
* **`realtime/` [Implemented]:** Manages the WebSocket server and broadcasts typed ingestion telemetry events.
* **`utils/` [Implemented]:** Houses shared helper utilities including file hashing and file deletion management (`file.ts`).

---

# 4. Backend Request Flow and API Contracts

## 4.1 Layered Request Architecture
All backend operations follow strict separation of concerns:
$$\text{HTTP Request} \longrightarrow \text{Route} \longrightarrow \text{Middleware} \longrightarrow \text{Controller} \longrightarrow \text{Service} \longrightarrow \text{RAG / Database} \longrightarrow \text{HTTP Response}$$

1. **Routes (`src/routes/`):** Define endpoints and attach middleware chains.
2. **Middleware (`src/middleware/`):** Verify JWT tokens, assert user roles, handle file uploads (Multer), and catch unhandled exceptions.
3. **Validators (`src/validators/`):** Validate request payloads at runtime using Zod schemas.
4. **Controllers (`src/controllers/`):** Parse input parameters, invoke services, and format standardized JSON responses.
5. **Services (`src/services/`):** Coordinate database transactions, background processing, and RAG execution.

## 4.2 REST API Endpoints Specification

| Category | Endpoint | Method | Auth / Role | Input Payload | Output / Response | Status |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **System** | `/` | `GET` | Public | None | `{ message: string }` | **Implemented** (Public health check) |
| **Documents**| `/api/documents/upload` | `POST` | `ADMIN` / `SUPER_ADMIN` | `multipart/form-data` (`files[]`) | `{ uploaded: Document[], skipped: SkippedDoc[] }` | **Implemented** (JWT + RBAC protected) |
| | `/api/documents` | `GET` | `USER` / `ADMIN` / `SUPER_ADMIN` | None | `Document[]` | **Implemented** (JWT + RBAC protected) |
| | `/api/documents/:id` | `GET` | `USER` / `ADMIN` / `SUPER_ADMIN` | None | `Document & { chunkCount: number }` | **Implemented** (JWT + RBAC protected) |
| | `/api/documents/:id` | `DELETE`| `ADMIN` / `SUPER_ADMIN` | None | `{ message: string, documentId: string, filename: string }` | **Implemented** (JWT + RBAC protected) |
| **Auth** | `/api/auth/register` | `POST` | Public | `{ email, password, name }` | `{ user: { id, email, role }, token }` | **Implemented** (Active route) |
| | `/api/auth/login` | `POST` | Public | `{ email, password }` | `{ user: { id, email, role }, token }` | **Implemented** (Active route) |
| | `/api/auth/me` | `GET` | Authenticated | None | `{ user: SafeUser }` | **Implemented** (JWT protected) |
| | `/api/auth/profile` | `PATCH` | Authenticated | `{ name: string }` | `{ message: string, user: SafeUser }` | **Implemented** (JWT protected) |
| | `/api/auth/password` | `PATCH` | Authenticated | `{ currentPassword, newPassword }` | `{ message: string }` | **Implemented** (JWT protected) |
| **Chat** | `/api/chat` | `POST` | `USER` / `ADMIN` / `SUPER_ADMIN` | `{ query, documentId?, conversationId?, systemPrompt? }` | `{ conversationId, answer, evidenceSufficient, refusalReason?, citations, modelName, providerName, remainingMessages, warning, isNewConversation, retrievalDebug? }` | **Implemented** (JWT + RBAC protected; `retrievalDebug` exposed for `ADMIN` & `SUPER_ADMIN`) |
| | `/ws` | `WS` | `USER` / `ADMIN` / `SUPER_ADMIN` | Client events: `auth`, `chat.send`, `chat.cancel` | Server events: `chat.start`, `chat.token`, `chat.complete`, `chat.error`, `document.*` | **Implemented** (JWT auth, client isolation) |
| | `/api/conversations` | `GET` | `USER` / `ADMIN` / `SUPER_ADMIN` | None | `{ conversations: Conversation[] }` | **Implemented** (JWT + RBAC protected) |
| | `/api/conversations/:id` | `GET` | `USER` / `ADMIN` / `SUPER_ADMIN` | None | `{ conversation: Conversation & { messages: Message[] }, messages: Message[] }` | **Implemented** (JWT + RBAC protected) |
| | `/api/conversations/:id` | `DELETE` | `USER` / `ADMIN` / `SUPER_ADMIN` | None | `{ message: string, id: string }` | **Implemented** (JWT + RBAC protected) |
| **Admin** | `/api/admin/users` | `GET` | `SUPER_ADMIN` | None | `{ users: SafeUser[] }` | **Implemented** (JWT + RBAC protected) |
| | `/api/admin/users/:id/role` | `PATCH` | `SUPER_ADMIN` | `{ role: RoleName }` | `{ message: string, user: SafeUser }` | **Implemented** (JWT + RBAC protected) |
| | `/api/admin/users` | `POST` | `SUPER_ADMIN` | `{ name, email, password, role }` | `{ message: string, user: SafeUser }` | **Implemented** (JWT + RBAC protected) |
| | `/api/admin/users/:id` | `DELETE` | `SUPER_ADMIN` | None | `{ message: string, user: SafeUser }` | **Implemented** (JWT + RBAC protected) |
| | `/api/admin/config` | `GET` | `SUPER_ADMIN` | None | `{ config: ProjectConfig }` | **Implemented** (JWT + RBAC protected) |
| | `/api/admin/config` | `PATCH` | `SUPER_ADMIN` | `Partial<ProjectConfig>` | `{ message: string, config: ProjectConfig }` | **Implemented** (JWT + RBAC protected) |
| **Prompts** | `/api/prompts` | `GET` | `ADMIN` / `SUPER_ADMIN` | Query: `type?`, `status?` | `Prompt[]` | **Implemented** (JWT + RBAC protected) |
| | `/api/prompts` | `POST` | `ADMIN` / `SUPER_ADMIN` | `{ name, content, type, status? }` | `Prompt` | **Implemented** (JWT + RBAC protected) |
| | `/api/prompts/active/:type` | `GET` | `ADMIN` / `SUPER_ADMIN` | None | `Prompt` | **Implemented** (JWT + RBAC protected) |
| | `/api/prompts/:id` | `GET` | `ADMIN` / `SUPER_ADMIN` | None | `Prompt` | **Implemented** (JWT + RBAC protected) |
| | `/api/prompts/:id` | `PATCH` | `ADMIN` / `SUPER_ADMIN` | `{ content?, status?, name? }` | `Prompt` | **Implemented** (JWT + RBAC protected) |
| | `/api/prompts/:id` | `DELETE` | `ADMIN` / `SUPER_ADMIN` | None | `{ message: string, id: string }` | **Implemented** (JWT + RBAC protected) |

*\*Note: The `/api/chat` route orchestrates `generateAnswer`, dynamic active system prompt lookup (with `systemPrompt` request override precedence), and transactional multi-turn session persistence in Supabase PostgreSQL (`conversations`, `messages`).*

### 4.3 Standard HTTP Response & Error Contracts
* **Success Envelope (200 OK / 201 Created):**
  ```json
  {
    "data": { ... },
    "message": "Operation completed successfully"
  }
  ```
* **Error Envelope (400 / 401 / 403 / 404 / 500):**
  ```json
  {
    "error": "Human-readable error description",
    "statusCode": 400,
    "details": [
      { "field": "email", "message": "Invalid email address format" }
    ]
  }
  ```

---

# 5. Document Ingestion and Background Processing

Document ingestion converts raw files into indexed vector chunks asynchronously without blocking HTTP threads.

```text
Upload ──→ SHA-256 Hash ──→ Ingestion Queue ──→ LlamaParse ──→ Normalizer
                                                                    │
Ready ←── pgvector Commit ←── Embed (Jina v2) ←── Structural Chunker ←┘
```

## 5.1 Pipeline Stages (`src/rag/ingestion/`)
1. **Per-Admin Document Limit & Deduplication (`document.service.ts`):** Enforces a maximum of `MAX_ACTIVE_DOCUMENTS_PER_ADMIN = 10` (configured in `src/config/rag.ts`) per admin using an in-process per-admin concurrency lock. Active documents include `uploaded`, `processing`, and `ready` states (failed documents and deleted documents release their slot). Computes SHA-256 hash across raw file bytes; duplicate hashes are skipped to prevent redundant compute.
   ```typescript
   export type ProcessUploadResult =
     | { uploaded: Document[]; skipped: SkippedDocument[] }
     | { error: "limitExceeded"; message: string; activeCount: number; attemptedCount: number };
   ```
2. **Local Storage:** Files are persisted to `backend/uploads/{timestamp}-{filename}`.
3. **Ingestion Queue (`queue.ts`):** In-memory asynchronous concurrency queue processing up to `INGESTION_CONCURRENCY = 3` documents simultaneously.
4. **Layout Parsing (`parser.ts`):** LlamaParse extracts text, structural headings, tables, and page markers into clean Markdown using `LLAMAPARSE_API_KEY`.
5. **Text Normalization (`cleaner.ts`):** Strips parsing artifacts, normalizes consecutive whitespace and linebreaks, cleans table formatting.
6. **Structural Chunking (`chunker.ts`):**
   - *Primary Strategy:* Heading-aware structural Markdown chunker segmenting at Markdown headers (`#`, `##`, `###`) to preserve topical context (`DEFAULT_STRUCTURAL_TARGET = 1000`, `DEFAULT_STRUCTURAL_MAX = 1200`). Micro-chunks below `DEFAULT_MIN_CHUNK_CHARS = 300` are merged into adjacent content to prevent isolated header fragments.
   - *Fallback Strategy:* Recursive sentence-splitting text splitter (`DEFAULT_FALLBACK_CHUNK_SIZE = 1000`, `DEFAULT_FALLBACK_OVERLAP = 120`) applied to documents without structural headers.
7. **Vector Embedding (`pipeline.ts`):** Batched embedding generation via in-process local model.
8. **Persistence (`persistence.ts`):** Writes chunks and 512-dimensional embeddings to `document_chunks` table within a single transaction, then transitions document status to `ready`.

## 5.2 Document States and Lifecycle Transitions
* `uploaded`: File saved to disk, metadata registered in `documents` table, awaiting queue execution.
* `processing`: Document currently undergoing parsing, chunking, or embedding.
* `ready`: Chunks and vectors committed to PostgreSQL pgvector; searchable by retrieval engine.
* `failed`: Unrecoverable error encountered; error recorded in server logs and WebSocket telemetry.

---

# 6. Database Schema, Storage, and Vector Configuration

The database is hosted on **Supabase PostgreSQL** with pgvector extension `0.8.2` enabled. Persistence is managed via **Drizzle ORM**.

## 6.1 Implemented Schema (`src/database/schema.ts`)

```typescript
// roles: Canonical role definitions (USER, ADMIN, SUPER_ADMIN)
export const roles = pgTable("roles", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(), // USER | ADMIN | SUPER_ADMIN
  description: text("description"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// users: User authentication profiles
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  roleId: uuid("role_id").notNull().references(() => roles.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_users_email").on(table.email),
  index("idx_users_role_id").on(table.roleId),
]);

// documents: Stores file metadata, hashing, and ingestion status
export const documents = pgTable("documents", {
  id: uuid("id").primaryKey().defaultRandom(),
  filename: text("filename").notNull(),
  fileType: text("file_type").notNull(),
  filePath: text("file_path").notNull(),
  contentHash: text("content_hash").notNull().unique(),
  status: text("status").notNull().default("uploaded"), // uploaded | processing | ready | failed
  uploadedBy: uuid("uploaded_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// document_chunks: Stores chunked text, page numbers, and 512-dim pgvector embeddings
export const documentChunks = pgTable("document_chunks", {
  id: uuid("id").primaryKey().defaultRandom(),
  documentId: uuid("document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
  content: text("content").notNull(),
  pageNumber: integer("page_number"),
  chunkIndex: integer("chunk_index").notNull(),
  embedding: vector("embedding", { dimensions: 512 }),
  metadata: jsonb("metadata").default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_document_chunks_document_id").on(table.documentId),
]);

// conversations: Multi-turn chat sessions
export const conversations = pgTable("conversations", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_conversations_user_id").on(table.userId),
]);

// messages: Chat history entries linked to conversations
export const messages = pgTable("messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  conversationId: uuid("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
  role: text("role").notNull(), // user | assistant
  content: text("content").notNull(),
  citations: jsonb("citations").default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_messages_conversation_id").on(table.conversationId),
]);

export type Role = typeof roles.$inferSelect;
export type NewRole = typeof roles.$inferInsert;
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Document = typeof documents.$inferSelect;
export type NewDocument = typeof documents.$inferInsert;
export type DocumentChunk = typeof documentChunks.$inferSelect;
export type NewDocumentChunk = typeof documentChunks.$inferInsert;
export type Conversation = typeof conversations.$inferSelect;
export type NewConversation = typeof conversations.$inferInsert;
export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
```

## 6.2 Prompts Schema Entity (`src/database/schema.ts`)
[Implemented in Milestone 2]

```typescript
// prompts: Admin-configured RAG and system prompts
export const prompts = pgTable("prompts", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  content: text("content").notNull(),
  type: text("type").notNull(), // system | rag | citation
  status: text("status").notNull().default("active"), // active | draft
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_prompts_type_status").on(table.type, table.status),
]);

export type Prompt = typeof prompts.$inferSelect;
export type NewPrompt = typeof prompts.$inferInsert;
```

---

# 7. Embeddings, Retrieval, and Similarity Search

## 7.1 In-Process Local Embeddings (`src/providers/embeddings/`)
* **Model:** `Xenova/jina-embeddings-v2-small-en` via Transformers.js (`@xenova/transformers`).
* **Vector Dimension:** `512` (aligns with `vector(512)` in Supabase PostgreSQL).
* **Pooling & Normalization:** Mean pooling with L2 normalization (`normalize: true`). Unit-norm vectors guarantee mathematical identity between cosine distance and dot-product ranking:
  $$\|u\| = 1, \quad \|v\| = 1 \implies \text{Cosine Similarity} = u \cdot v$$
* **Provider Implementation:** `LocalEmbeddingProvider` implements `EmbeddingProvider`. Utilizes a singleton pipeline promise to prevent duplicate model loads in memory.
* **API Embedding Provider Option:** The `EmbeddingProvider` interface allows plugging in high-throughput cloud providers (e.g. Gemini Embeddings) in future phases without altering ingestion logic.

```typescript
export interface EmbeddingProvider {
  readonly modelName: string;
  readonly dimensions: number;
  generateEmbedding(text: string): Promise<number[]>;
  generateEmbeddings(texts: string[]): Promise<number[][]>;
}
```

## 7.2 Semantic Retrieval Layer (`src/rag/retrieval/`)
* **Retriever:** `PGVectorRetriever` extending LlamaIndex.TS `BaseRetriever`.
* **Distance Metric:** PostgreSQL pgvector cosine distance operator (`<=>`).
* **Similarity Score Expression:**
  ```typescript
  const similarityExpr = sql<number>`1 - (${cosineDistance(documentChunks.embedding, queryEmbedding)})`;
  ```
* **Query Constraints:** Filters strictly by documents where `status = 'ready'`. Orders by distance ascending (similarity descending).
* **Parameters:** Configurable `topK` (default: `5`, via `DEFAULT_RETRIEVAL_TOP_K`), optional `documentId` filter, content deduplication to prevent repetitive chunks across pages, optional `minSimilarity` threshold (default: `0.50`, via `DEFAULT_MIN_SIMILARITY`).
* **Compatibility:** Emits LlamaIndex `NodeWithScore` objects containing `TextNode` instances for Phase 2 query-engine compatibility.

```typescript
export interface RetrievedChunk {
  id: string;
  documentId: string;
  filename: string;
  content: string;
  pageNumber: number | null;
  chunkIndex: number;
  similarity: number;
  metadata?: Record<string, unknown>;
}

export interface RetrieveOptions {
  topK?: number | undefined;
  documentId?: string | undefined;
  minSimilarity?: number | undefined;
  embeddingProvider?: EmbeddingProvider | undefined;
}
```

---

# 8. LLM Providers, Prompt Management, and Generation

## 8.1 LLM Provider Abstraction (`src/providers/llm/`)
Vendor-neutral interface communicating via native Node.js `fetch` (zero third-party wrapper dependencies):

```typescript
export interface GenerateOptions {
  temperature?: number | undefined;
  maxTokens?: number | undefined;
  systemPrompt?: string | undefined;
}

export interface LLMProvider {
  readonly providerName: string;
  readonly modelName: string;
  generate(prompt: string, options?: GenerateOptions): Promise<string>;
}
```

### Supported Providers
1. **Groq (Cloud API):** Endpoint `https://api.groq.com/openai/v1/chat/completions`, model `qwen/qwen3.8-27b`. Configured via `GROQ_API_KEY` and `GROQ_MODEL`.
2. **Google Gemini (Cloud API):** Endpoint `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`, model `gemini-flash-latest`. Configured via `GEMINI_API_KEY` and `GEMINI_MODEL`.
3. **Local Ollama (Local Server):** Endpoint `http://127.0.0.1:11434/api/chat`, model `hf.co/unsloth/Qwen3.5-0.8B-GGUF:Q4_K_M`. Configured via `OLLAMA_BASE_URL` and `OLLAMA_MODEL`. Supports thinking token stream fallback.

**Provider Selection:** Controlled via `LLM_PROVIDER` (`groq` | `gemini` | `ollama`). Factory function `getLLMProvider()` instantiates the designated provider.

```typescript
export const getLLMProvider = (providerType: string = LLM_PROVIDER): LLMProvider => {
  switch (providerType.toLowerCase()) {
    case "groq": return groqLLMProvider;
    case "gemini": return geminiLLMProvider;
    case "ollama": return ollamaLLMProvider;
    default: return groqLLMProvider;
  }
};
```

## 8.2 Prompt Architecture (`src/rag/generation/prompt.ts`)
The generation layer enforces strict grounding through `DEFAULT_RAG_SYSTEM_PROMPT`:
```text
You are a precise, truth-focused document question-answering assistant.
Your answers MUST be strictly grounded in the provided Evidence Sources.

CRITICAL RULES:
1. Use ONLY the facts directly mentioned in the provided Evidence Sources. Do NOT use outside knowledge, prior knowledge, speculation, or unstated assumptions.
2. If the provided Evidence Sources do not contain sufficient information to directly answer the question, or if they are irrelevant to the question, you MUST decline to answer and respond with EXACTLY:
INSUFFICIENT_EVIDENCE: <brief explanation of what information is missing>
3. If the evidence IS sufficient, answer the user's question clearly, concisely, and accurately based only on the sources.
4. Always cite your sources in the text using bracketed source tags like [Source 1], [Source 2] immediately following the facts they support.
5. Do NOT invent or make up citations. Only cite sources provided in the Evidence Sources list.
```

Context formatting concatenates evidence with numbered tags:
`[Source {i}] (Document: "{filename}", Page: {page}, Chunk: {index}):\n{content}`

## 8.3 Dynamic Prompt Selection and Generator Integration (`src/rag/generation/generator.ts`)
The generator integrates database-managed system prompts with the following resolution precedence per generation request:
1. **Explicit Override:** If `options.systemPrompt` is passed, it is used immediately without querying the database.
2. **Database Active System Prompt:** Otherwise, `promptsService.getActivePrompt("system")` is queried once. If an active prompt exists and has non-empty content, its content is applied.
3. **Graceful Fallback:** If no active system prompt exists in the database, the generator falls back to `DEFAULT_RAG_SYSTEM_PROMPT`.
4. **Resilient Error Handling:** If the database query encounters an unexpected network/database failure, the error is logged as a warning (`console.warn`) and the generator automatically falls back to `DEFAULT_RAG_SYSTEM_PROMPT` without disrupting answer generation.

---

# 9. Evidence Sufficiency, Grounding Safeguards, and Citations

The generation pipeline implements a **dual-layer grounding verification architecture to minimize hallucinations**:

```text
Retrieved Chunks ──→ Layer 1: Pre-Generation Gate (src/rag/generation/sufficiency.ts)
                         │
                         ├─ [0 Chunks OR Top Similarity < 0.65] ──→ Structured Refusal (Bypass LLM)
                         │
                         ↓ [Sufficient]
                     Layer 2: In-Context Sentinel Gate (src/rag/generation/prompt.ts)
                         │
                         ├─ [Model outputs "INSUFFICIENT_EVIDENCE: ..."] ──→ Structured Refusal
                         │
                         ↓ [Model outputs Grounded Answer]
                     Extract & Map Citations (src/rag/generation/generator.ts)
```

## 9.1 Sufficiency Gates
1. **Layer 1: Pre-Generation Quantitative Gate (`sufficiency.ts`):** Checks retrieved chunk count and top cosine similarity against `DEFAULT_MIN_SUFFICIENCY_SCORE = 0.65`. If similarity is below threshold, generation short-circuits immediately. Returns `evidenceSufficient: false`, saving token cost and inference latency.
2. **Layer 2: In-Context Refusal Sentinel Gate (`generator.ts`):** If retrieved chunks are topically adjacent but fail to address the specific question, the system prompt instructs the model to return `INSUFFICIENT_EVIDENCE: <reason>`. The generator parses this prefix, sets `evidenceSufficient: false`, and provides a user-friendly refusal message without fabricating content.

## 9.2 Source Citations Mapping
* **Tag Matching:** Generator scans response text for `\[Source\s+(\d+)\]` patterns.
* **Metadata Attachment:** Maps source indices back to `RetrievedChunk` instances to assemble structured `Citation` objects:

```typescript
export interface Citation {
  documentId: string;
  filename: string;
  pageNumber: number | null;
  chunkIndex: number;
  chunkId: string;
  similarity: number;
  snippet: string; // Excerpt (~200 characters)
}

export interface GenerateAnswerResult {
  answer: string;
  evidenceSufficient: boolean;
  refusalReason?: string | undefined;
  citations: Citation[];
  retrievedChunks: RetrievedChunk[];
  modelName: string;
  providerName: string;
  retrievalDebug: RetrievalDebugInfo;
}
```

---

# 10. WebSocket Events and Real-Time Communication

A lightweight WebSocket server is mounted on the Node HTTP server at path `/ws`. It streams background document ingestion progress directly to clients without polling.

## 10.1 Ingestion Lifecycle Events Contract (`src/realtime/events.ts`)

```typescript
export type IngestionEventType =
  | "document.processing"
  | "document.parsing"
  | "document.chunking"
  | "document.embedding"
  | "document.ready"
  | "document.failed";

export interface IngestionEventPayload {
  documentId: string;
  filename?: string;
  totalChunks?: number;
  totalPages?: number;
  error?: string;
  timestamp?: string;
}

export interface IngestionEvent {
  type: IngestionEventType;
  payload: IngestionEventPayload;
}
```

| Event Name | Stage Description | Payload Metadata |
| :--- | :--- | :--- |
| `document.processing` | Ingestion initiated; document marked as processing | `{ documentId, filename }` |
| `document.parsing` | Text and layout extraction begun via LlamaParse | `{ documentId, filename }` |
| `document.chunking` | Content segmented into structural chunks | `{ documentId, filename, totalPages }` |
| `document.embedding` | Chunk vector embeddings being generated | `{ documentId, filename, totalChunks }` |
| `document.ready` | Chunks & vectors persisted; document ready | `{ documentId, filename, totalPages, totalChunks }` |
| `document.failed` | Unrecoverable error encountered | `{ documentId, filename, error }` |

**Decoupled Architecture:** Business logic emits events through `publishIngestionEvent(type, payload)`. The RAG pipeline remains completely decoupled from client socket state.

---

# 11. Authentication, Validation, and Security Contracts (Implemented)

The security architecture implements the following authentication, authorization, and validation safeguards:

1. **Backend as Security Boundary:** Role verification, file validation, document authorization, and prompt management must be validated on Express routes. The frontend is never trusted as a security barrier.
2. **Password Hashing:** Salted hashing via `bcrypt` (10 rounds). Plaintext passwords must never be logged or stored.
3. **Session Tokens:** Stateless JWT tokens passed via `Authorization: Bearer <token>` containing payload `{ sub: userId, role: string, exp: number }`.
4. **Input Validation (Architectural Contract):** Controller-level validation enforces required types, string trimming, regex patterns (email, UUID), and password constraints. Planned centralized runtime validation middleware using strict Zod schemas with TypeScript type inference (`z.infer<typeof schema>`), to be wired into route middleware (`src/validators/`):
   ```typescript
   export const uploadDocumentSchema = z.object({
     files: z.array(z.any()).min(1, "At least one file must be provided"),
   });

   export const chatQuerySchema = z.object({
     query: z.string().trim().min(1, "Query cannot be empty"),
     conversationId: z.string().uuid().optional(),
     documentId: z.string().uuid().optional(),
   });
   ```
5. **Data Protection:** Database credentials, cloud keys, and API tokens must never be committed to Git. `.env` is strictly ignored. All database queries use Drizzle ORM parameterized statements to eliminate SQL injection vulnerabilities.

---

# 12. Environment Configuration and Development Rules

## 12.1 Environment Variables Reference (`backend/src/config/env.ts`)

| Variable | Required | Default / Fallback | Purpose |
| :--- | :--- | :--- | :--- |
| `PORT` | Optional | `3000` | Express server port |
| `CORS_ORIGIN` | Optional | `http://localhost:3000,http://localhost:3001` | Allowed frontend origins for CORS (comma-separated) |
| `DATABASE_URL` | **Required** | None | Supabase PostgreSQL connection string |
| `LLAMAPARSE_API_KEY` | **Required** | None | LlamaParse document extraction API key |
| `JWT_SECRET` | **Required (prod)** | None (no insecure fallback) | Secret key used for signing and verifying authentication JWTs |
| `JWT_EXPIRES_IN` | Optional | `7d` | Token expiration lifespan for issued JWT session tokens |
| `EMBEDDING_PROVIDER` | Optional | `local` | Active embedding provider (`local`) |
| `EMBEDDING_MODEL` | Optional | `Xenova/jina-embeddings-v2-small-en` | Active embedding model |
| `LLM_PROVIDER` | Optional | `ollama` (or `groq` / `gemini`) | Active LLM generation provider |
| `LLM_MODEL` | Optional | Dynamic matching active provider | Global override for LLM model |
| `GROQ_API_KEY` | Optional | `""` | Groq cloud API key |
| `GROQ_MODEL` | Optional | `qwen/qwen3.8-27b` | Default Groq model |
| `GEMINI_API_KEY` | Optional | `""` | Google Gemini API key |
| `GEMINI_MODEL` | Optional | `gemini-flash-latest` | Default Gemini model |
| `OLLAMA_BASE_URL` | Optional | `http://127.0.0.1:11434` | Local Ollama HTTP endpoint |
| `OLLAMA_MODEL` | Optional | `hf.co/unsloth/Qwen3.5-0.8B-GGUF:Q4_K_M`| Default Ollama model |
| `INGESTION_CONCURRENCY`| Optional | `3` | Parallel background document worker limit |
| `SUPER_ADMIN_NAME` | Optional | `Super Admin` | Initial super admin display name for db seeding |
| `SUPER_ADMIN_EMAIL` | Optional | `admin@nnt-rag.com` | Initial super admin email for db seeding |
| `SUPER_ADMIN_PASSWORD` | Optional | `Admin@12345` | Initial super admin password (bcrypt hashed during seed) |

## 12.2 Development Rules (AGENTS.md)
* **Smallest Clean Implementation:** Implement only what is directly requested. Never introduce speculative scaffolding or redundant wrapper layers.
* **Preserve Working Code:** Modify only files required for the task. Do not rewrite or restyle unrelated working code.
* **Node.js ESM Standard:** Use ESM imports with mandatory `.js` file extensions (`import ... from "./foo.js"`).
* **Strict TypeScript:** Strict type safety required (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`). No `any` types.
* **Blueprint Synchronization:** Update this document whenever an architectural or technical contract changes.

---

# 13. Current Project Status, Testing, and Phase 1 Acceptance Criteria

## 13.1 Implementation Status

| Component | Status | Verified Implementation Details |
| :--- | :--- | :--- |
| **Database & pgvector** | **Implemented** | Supabase PostgreSQL, pgvector 0.8.2, vector(512), Drizzle schema with cascading deletes. |
| **Document Ingestion** | **Implemented** | Multipart upload, SHA-256 deduplication, LlamaParse parsing, structural chunking, queue (`concurrency=3`). |
| **Local Embeddings** | **Implemented** | In-process Jina v2 small (512 dims, unit norm) via Transformers.js with singleton pipeline caching. |
| **Semantic Retrieval** | **Implemented** | `PGVectorRetriever` with cosine distance (`<=>`), status filtering, topK parameterization. |
| **LLM Provider Layer** | **Implemented** | Vendor-agnostic HTTP adapters for Groq, Gemini, and Ollama. |
| **Evidence Sufficiency** | **Implemented** | Dual-layer check: pre-generation score gate (`0.65`) + in-context refusal sentinel. |
| **Grounded Answer & Citations**| **Implemented** | Strict grounding prompt, source tag extraction, metadata citation resolution. |
| **Realtime WebSockets** | **Implemented** | Mounted on `/ws`, broadcasts 6 ingestion lifecycle events. |
| **Chat HTTP Endpoint** | **Implemented** | Express endpoint `POST /api/chat` with input validation (including optional `systemPrompt` override forwarding), error handling, evidence sufficiency gating, and citations. |
| **Conversation Persistence**| **Implemented** | Database tables (`conversations`, `messages`), multi-turn session persistence service, cascading deletion. |
| **User Authentication & RBAC** | **Implemented** | Registration, login, profile editing, password change with bcrypt (10 rounds), JWT issuance, and route protection middleware (`auth.middleware.ts`, `role.middleware.ts`). |
| **Prompt Management API** | **Implemented** | Database table (`prompts`), admin CRUD endpoints (`/api/prompts`) for system/RAG prompt overrides. |
| **RAG Prompt Generator Integration** | **Implemented** | Dynamic active system prompt lookup in `generateAnswer` with graceful fallback to `DEFAULT_RAG_SYSTEM_PROMPT` and explicit override precedence. |
| **Project Runtime Configuration** | **Implemented** | Endpoints (`GET/PATCH /api/admin/config`) with disk persistence (`runtime-settings.json`), in-memory sync, and runtime provider/model/concurrency/chunking updates. |
| **Next.js Frontend UI** | **Implemented** | Complete production Next.js App Router UI with Chat, Ingestion telemetry, Prompt & Super Admin consoles, User Profile, Settings, and Dark Theme. |

## 13.2 Acceptance Criteria by Milestone

### Milestone 1: Foundational RAG, Ingestion & Retrieval (Implemented)
- [x] **Document Ingestion:** Multi-file upload (PDF, DOCX, TXT) parsed via LlamaParse, structurally chunked, embedded locally, and indexed into pgvector with live WebSocket telemetry (`/ws`).
- [x] **Deduplication:** SHA-256 content hashing prevents redundant document ingestion.
- [x] **Semantic Retrieval:** `PGVectorRetriever` retrieves top-K chunks via pgvector cosine distance (`<=>`).
- [x] **Sufficiency Gating & Refusal:** Quantitative similarity score gate (`0.65`) and in-context sentinel (`INSUFFICIENT_EVIDENCE:`) trigger structured refusal on insufficient evidence.
- [x] **Grounded Generation & Citations:** LLM synthesis strictly grounded in evidence chunks with bracketed `[Source X]` citations mapped to source metadata.
- [x] **Multi-Provider LLM Integration:** Flexible support for Groq, Gemini, and local Ollama.
- [x] **Build Verification:** Zero TypeScript compilation errors (`npm run build`).

### Milestone 2: Authentication, Chat Persistence & Administration (Implemented)
- [x] **Authentication:** User registration/login with bcrypt hashing (10 salt rounds), server-side `USER` role assignment, stateless JWT issuance, and generic credential failure responses.
- [x] **Super Admin Bootstrapping:** Idempotent database seeding (`npm run db:seed`) creates canonical roles and initial `SUPER_ADMIN` account with bcrypt-hashed credentials configured via environment variables.
- [x] **RBAC Route Protection:** Server-side role middleware on protected endpoints (`auth.middleware.ts`, `role.middleware.ts`).
- [x] **User Administration:** User management endpoints (`GET /api/admin/users`, `PATCH /api/admin/users/:id/role`, `POST /api/admin/users`, `DELETE /api/admin/users/:id`) with role-based protections against self-demotion, self-deletion, and last super admin deletion.
- [x] **Conversational History:** Multi-turn conversation sessions and message persistence in PostgreSQL (`conversations`, `messages`).
- [x] **Chat HTTP Route:** Express endpoint `/api/chat` orchestrating `generateAnswer` with conversation persistence and explicit system prompt override support.
- [x] **Prompt Administration API:** Database-backed prompt storage and administrative CRUD endpoints (`/api/prompts`).
- [x] **RAG Generator Prompt Integration:** Dynamic resolution of active system prompt from database with fallback to default on absence or failure, preserving strict grounding and citation behavior.
- [x] **Document Lifecycle Management:** Document deletion endpoint (`DELETE /api/documents/:id`) with cascading chunk removal and local file cleanup.

### Milestone 3: Next.js Frontend Web Application (Implemented)
- [x] **Document Management Interface (`/documents`):** Drag-and-drop multi-file upload dropzone, real-time WebSocket progress bars tracking parsing/chunking/embedding stages, document table with status badges, and document deletion.
- [x] **Interactive Conversational UI (`/`):** Full multi-turn chat experience with prompt suggestions, assistant/user bubbles, markdown and code blocks, copy action, and grounded responses.
- [x] **Source Inspector & Citations:** Interactive citation badges on assistant messages opening a focused side drawer displaying source document name, page number, similarity score, and exact retrieved chunk text excerpt.
- [x] **Prompt Administration Console (`/admin`):** Admin & Super Admin interface for creating, reviewing, editing, toggling active status, and deleting system prompt templates.
- [x] **Super Admin Management & Configuration (`/admin/super`):** Dedicated console featuring administrative user provisioning, role promotion/demotion, user deletion, and dynamic project runtime settings (LLM provider, model, temperature, topK, similarity threshold, chunk size, overlap, concurrency).
- [x] **Chat History Management:** Collapsible sidebar with conversation listing, three-dot options menu, confirmation modal for conversation deletion, cascading database message cleanup, and active chat reset.
- [x] **Profile & Account Settings (`/profile`, `/settings`):** User profile view with display name editing, and account settings with secure current password verification and bcrypt-hashed password updating.
- [x] **Logout Flow & Confirmation:** Accessible confirmation dialog before terminating session, leaving session intact on cancel, and cleaning credentials on confirmation.

---

# 14. Architecture Decision Log & Future Scope

## 14.1 Architecture Decision Log
* **2026-10-05 — Unified Supabase Database:** Selected Supabase PostgreSQL + pgvector over standalone vector databases. Consolidates relational data and vector embeddings into a single transactional database, avoiding distributed sync complexity.
* **2026-10-07 — In-Process Local Embeddings:** Adopted `Xenova/jina-embeddings-v2-small-en` (512 dimensions) via Transformers.js. Ensures zero per-token inference cost, complete data privacy, and exact alignment with `vector(512)` schema.
* **2026-10-08 — Decoupled WebSocket Telemetry:** Created lightweight WebSocket layer at `/ws` using `ws` library. Eliminates client polling overhead while maintaining a decoupled event boundary (`publishIngestionEvent()`).
* **2026-10-08 — pgvector Semantic Retrieval:** Built `PGVectorRetriever` subclassing LlamaIndex.TS `BaseRetriever` using pgvector cosine distance operator `<=>`.
* **2026-10-08 — Dual-Layer Evidence Sufficiency & Citations:** Implemented pre-generation similarity gating (threshold `0.65`) combined with LLM sentinel refusal parsing (`INSUFFICIENT_EVIDENCE:`) to systematically mitigate hallucinations, refuse out-of-domain queries, and attach verifiable source citations.
* **2026-10-08 — Ollama Provider Integration & Provider Symmetry:** Integrated local Ollama provider with installed model `hf.co/unsloth/Qwen3.5-0.8B-GGUF:Q4_K_M` alongside Groq and Gemini, featuring configurable environment selection and reasoning-stream support.
* **2026-10-13 — Dynamic RAG System Prompt Integration:** Integrated active system prompt selection into `generator.ts` with explicit option override precedence, single-query lookup via `promptsService.getActivePrompt("system")`, graceful fallback to `DEFAULT_RAG_SYSTEM_PROMPT` on query error or absence, and zero disturbance to retrieval, evidence gating, and citation mapping.
* **2026-10-15 — Dynamic Project Runtime Configuration:** Introduced `runtime-settings.json` backed by `config.service.ts` allowing Super Admins to adjust active LLM provider, models, temperature, retrieval topK, similarity thresholds, and concurrency at runtime without restarting the server.
* **2026-10-15 — Reusable AppLayout Shell:** Created lightweight layout wrapper (`AppLayout`) for Next.js secondary views (`/profile`, `/settings`), drastically reducing duplicate sidebar/topbar boilerplate while preserving responsive state and authentication gates.
* **2026-10-15 — Server-Side User Profile & Password Security:** Added `/api/auth/me`, `/api/auth/profile`, and `/api/auth/password` with server-side bcrypt password verification and rehashing, enforcing strict separation between non-privileged user fields and role assignment.
* **2026-10-28 — Open Knowledge Format (OKF v0.2) Foundation & Query Router Contract (Milestone 1):** Introduced hierarchical knowledge bundle under `knowledge/bundle/` conforming to official Google OKF v0.2 specifications (SPEC.md). Built zero-dependency TypeScript parser, conformance validator, bundle loader, and pre-retrieval query routing interface (`RuleBasedQueryRouter`) categorizing user queries across 5 intents (`greeting`, `okf_topic`, `document_rag`, `out_of_scope`, `ambiguous_mixed`). Preserves strict grounding policy and existing pgvector RAG pipeline intact.
* **2026-10-28 — OKF Live Query Flow Integration & Pre-Retrieval Gate (Milestone 2):** Integrated `RuleBasedQueryRouter` and OKF loader into live chat request flow (`POST /api/chat`) as a pre-retrieval routing gate via `routeChatQuery`. Conversational greetings (`greeting`), system architecture/capability inquiries (`okf_topic`), and out-of-domain questions (`out_of_scope`) are resolved deterministically before retrieval, bypassing pgvector search and LLM synthesis while returning grounded responses with concept file citations (`architecture/pipeline.md`, `capabilities/supported_formats.md`). Explicit document queries (`document_rag`) and ambiguous mixed queries seamlessly flow into the existing authorized pgvector RAG pipeline, preserving evidence sufficiency checks, dual-layer sentinels, authorization guards, and 50-message conversational persistence.

## 14.2 Remaining & Future Scope (Phase 2+)
While Phase 1 core functionality is 100% complete, the following improvements and advanced capabilities are identified for Phase 2:
1. **Frontend Token-by-Token Chat Streaming:** Upgrading frontend chat reception from discrete JSON request/response to live character-by-character token streaming over WebSockets or Server-Sent Events (SSE).
2. **Centralized Zod Validation Middleware:** Migrating controller-level inline request validation into centralized Express middleware schemas under `src/validators/`.
3. **Centralized Express Error Middleware:** Consolidating HTTP error envelope serialization into an application-wide Express error handler (`error.middleware.ts`).
4. **Cloud Object Storage:** Replacing local filesystem storage (`backend/uploads/`) with AWS S3 or Supabase Storage for multi-instance scaling.
5. **Hybrid Search & Advanced Retrieval:** Combining lexical keyword search (BM25 / pg_trgm) with pgvector semantic search, followed by cross-encoder reranking (Cohere / BGE).
6. **In-Browser Document Preview:** Embedding an interactive PDF viewer directly inside the Source Inspector Drawer to display the highlighted source page alongside the text snippet.
7. **Search & Pagination Filters:** Adding keyword search filters to conversation history in the sidebar and paginating large user lists in the Super Admin console.
Cloud object storage (S3/Supabase Storage), hybrid BM25 + vector search, cross-encoder reranking, query rewriting, conversation-aware retrieval, prompt versioning, streaming LLM responses over WebSockets/SSE, and automated RAG evaluation benchmarking.
