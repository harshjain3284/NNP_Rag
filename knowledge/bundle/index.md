---
okf_version: "0.2"
---

# Architecture

* [RAG Pipeline](architecture/pipeline.md) - End-to-end document ingestion, vector retrieval, and grounded answer synthesis.
* [Storage Architecture](architecture/storage.md) - PostgreSQL persistence, pgvector 512-dimension vector indexing, and Drizzle schema contracts.

# System Capabilities

* [Supported Formats](capabilities/supported_formats.md) - Ingestion file format support, layout parsing, and document extraction.
* [Roles and Permissions](capabilities/roles_and_permissions.md) - RBAC roles, permission boundaries, and administrator access control.

# Policies

* [Grounding Policy](policies/grounding_policy.md) - Dual-layer evidence sufficiency gating, hallucination prevention, and refusal rules.
