---
type: System Capability
title: Supported Ingestion Formats
description: File formats, file limits, and document parsing options supported by NNT RAG.
tags: [capabilities, documents, upload, formats, parsing]
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

# Supported Formats

NNT RAG supports the following document formats for ingestion:

- **Portable Document Format (`.pdf`)**: Parsed via LlamaParse into structured Markdown with headings, tables, and page boundaries.
- **Microsoft Word Document (`.docx`)**: Parsed via LlamaParse layout extraction.
- **Plain Text (`.txt`)**: Text ingestion with structural or sentence-based segmentation.
- **Open Knowledge Format (`.md`)**: Local-first Markdown concept files with YAML frontmatter, parsed without cloud API dependencies.

# Upload Limits & Constraints

- **File Size Limit**: Up to 25 MB per uploaded file.
- **Batch Upload Limit**: Up to 10 files per single upload request.
- **Active Document Limit**: Maximum 10 active documents per administrator (`MAX_ACTIVE_DOCUMENTS_PER_ADMIN = 10`), enforced with an in-process concurrency lock.
- **Deduplication**: Files with identical SHA-256 content hashes are detected and skipped to prevent duplicate vector storage.
