---
type: Architecture Component
title: PostgreSQL and pgvector Storage
description: Persistent relational data and 512-dimensional vector storage managed through Drizzle ORM.
tags: [storage, postgresql, pgvector, drizzle, schema]
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

Storage is consolidated in Supabase PostgreSQL with the `pgvector` extension enabled (`0.8.2`). All database operations, migrations, and declarative schema models are defined using Drizzle ORM.

# Schema Entities

1. **`roles`**: Defines system authorization roles (`USER`, `ADMIN`, `SUPER_ADMIN`).
2. **`users`**: Manages authentication credentials, bcrypt-salted password hashes (10 rounds), and foreign key role mappings.
3. **`documents`**: Tracks document metadata, including original filename, storage filepath, SHA-256 deduplication content hash, processing status (`uploaded`, `processing`, `ready`, `failed`), and uploader identity (`uploaded_by`).
4. **`document_chunks`**: Stores segmented text, page numbers, chunk order indexes, 512-dimension vector embeddings (`vector(512)`), and flexible `jsonb("metadata")` payloads. Deletions on `documents` cascade automatically to remove associated chunks.
5. **`conversations` & `messages`**: Multi-turn chat session state, message sequences, and JSONB citation records.
6. **`prompts`**: Administrator-managed system and RAG prompt templates with active status toggles.
