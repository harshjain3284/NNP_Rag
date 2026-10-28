---
type: System Capability
title: Roles and Access Control
description: Server-side RBAC role matrix, protected operations, and permissions.
tags: [security, rbac, roles, permissions, authorization]
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

# Roles & Permissions Matrix

NNT RAG enforces strict server-side role-based access control (RBAC). The backend Express API acts as the sole security boundary; frontend state is never trusted for authorization.

| Role | Scope & Permissions | Protected Operations |
| :--- | :--- | :--- |
| **USER** | Document Q&A consumer. Can query documents, view grounded answers and citations, and manage personal multi-turn conversations. | Cannot upload/delete documents, cannot edit prompts, cannot access admin consoles. |
| **ADMIN** | Knowledge and prompt administrator. Can upload up to 10 active documents, trigger ingestion, delete owned documents, manage system prompts, and inspect retrieval debug information. | Document upload/deletion (`/api/documents`), prompt management (`/api/prompts`), retrieval debug access. |
| **SUPER_ADMIN** | System administrator. Can manage user accounts, assign/modify roles, delete any document, update global prompts, and configure runtime hyperparameters. | User administration (`/api/admin/users`), runtime configuration (`/api/admin/config`). |
