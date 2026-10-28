import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  parseOKFDocument,
  validateOKFDocument,
  deriveTrustTier,
  isConceptStale,
  serializeOKFDocument,
  loadOKFBundle,
  getBundleTopicSummaries,
  findConcept,
  RuleBasedQueryRouter,
  defaultQueryRouter,
  OKFParseError,
  type OKFDocument,
} from "../src/rag/okf/index.js";

describe("Open Knowledge Format (OKF v0.2) Parser & Validator", () => {
  it("should parse a valid OKF concept file with frontmatter and body", () => {
    const raw = `---
type: Architecture Component
title: Pipeline Flow
description: Overview of ingestion and retrieval
tags: [pipeline, rag]
status: stable
generated:
  by: reference_agent/nnt-rag
  at: '2026-10-28T12:00:00Z'
verified:
  - by: human:admin
    at: '2026-10-28T12:00:00Z'
sources:
  - id: blueprint
    resource: /project_blueprint.md
---

# Section 1
This is the markdown body.`;

    const doc = parseOKFDocument(raw, "architecture/pipeline.md");
    assert.equal(doc.frontmatter.type, "Architecture Component");
    assert.equal(doc.frontmatter.title, "Pipeline Flow");
    assert.equal(doc.frontmatter.description, "Overview of ingestion and retrieval");
    assert.deepEqual(doc.frontmatter.tags, ["pipeline", "rag"]);
    assert.equal(doc.trustTier, "human-reviewed");
    assert.equal(doc.isStale, false);
    assert.equal(doc.conceptId, "architecture/pipeline");
    assert.ok(doc.body.includes("# Section 1"));

    const validation = validateOKFDocument(doc);
    assert.equal(validation.isValid, true);
    assert.equal(validation.errors.length, 0);
  });

  it("should throw OKFParseError on unterminated frontmatter", () => {
    const raw = `---
type: Incomplete
title: No Closing Delimiter
Body starts here`;

    assert.throws(
      () => parseOKFDocument(raw, "test.md"),
      (err: unknown) => err instanceof OKFParseError && err.message.includes("Unterminated")
    );
  });

  it("should throw OKFParseError on invalid YAML syntax", () => {
    const raw = `---
type: Broken
tags: [unclosed, array
---
Body`;

    assert.throws(
      () => parseOKFDocument(raw, "broken.md"),
      (err: unknown) => err instanceof OKFParseError && err.message.includes("Invalid YAML")
    );
  });

  it("should throw OKFParseError when frontmatter is not a mapping/object", () => {
    const raw = `---
- item 1
- item 2
---
Body`;

    assert.throws(
      () => parseOKFDocument(raw, "list.md"),
      (err: unknown) => err instanceof OKFParseError && err.message.includes("YAML mapping")
    );
  });

  it("should parse pure markdown without frontmatter gracefully", () => {
    const raw = "# Just a title\nNo frontmatter here.";
    const doc = parseOKFDocument(raw, "plain.md");
    assert.equal(doc.frontmatter.type, "");
    assert.equal(doc.body, raw);
    assert.equal(doc.trustTier, "unverified");

    // Conformance validator flags missing type
    const validation = validateOKFDocument(doc);
    assert.equal(validation.isValid, false);
    assert.ok(validation.errors.some((e) => e.includes("'type' is required")));
  });

  it("should enforce Conformance Rule 2 (§11): 'type' is required for concept files", () => {
    const raw = `---
title: Missing Type Field
description: Should fail validation
---
# Content`;

    const doc = parseOKFDocument(raw, "no-type.md");
    const validation = validateOKFDocument(doc);
    assert.equal(validation.isValid, false);
    assert.ok(validation.errors.some((e) => e.includes("Missing required frontmatter key: 'type'")));
  });

  it("should validate reserved files (index.md & log.md) correctly", () => {
    // 1. Root index.md allows okf_version in frontmatter
    const rootIndex = parseOKFDocument(
      `---\nokf_version: "0.2"\n---\n# Root Index\n* [Item](item.md)`,
      "index.md"
    );
    const rootVal = validateOKFDocument(rootIndex, { isReservedFile: "index", isRootIndex: true });
    assert.equal(rootVal.isValid, true);

    // 2. Subdirectory index.md MUST NOT contain frontmatter
    const subIndexWithFm = parseOKFDocument(
      `---\ntype: Index\n---\n# Sub Index`,
      "sub/index.md"
    );
    const subVal = validateOKFDocument(subIndexWithFm, { isReservedFile: "index", isRootIndex: false });
    assert.equal(subVal.isValid, false);
    assert.ok(subVal.errors.some((e) => e.includes("Subdirectory index.md files MUST NOT contain frontmatter")));

    // 3. Subdirectory index.md without frontmatter is valid
    const cleanSubIndex = parseOKFDocument(`# Sub Index\n* [Doc](doc.md)`, "sub/index.md");
    const cleanSubVal = validateOKFDocument(cleanSubIndex, { isReservedFile: "index", isRootIndex: false });
    assert.equal(cleanSubVal.isValid, true);

    // 4. log.md MUST NOT contain frontmatter
    const logWithFm = parseOKFDocument(`---\ntitle: Log\n---\n# Log`, "log.md");
    const logVal = validateOKFDocument(logWithFm, { isReservedFile: "log" });
    assert.equal(logVal.isValid, false);
    assert.ok(logVal.errors.some((e) => e.includes("log.md files MUST NOT contain frontmatter")));
  });

  it("should derive trust tiers according to OKF v0.2 §5.3", () => {
    // 1. Unverified
    const docUnverified = parseOKFDocument(`---\ntype: Test\n---`);
    assert.equal(deriveTrustTier(docUnverified.frontmatter), "unverified");

    // 2. Machine-confirmed (bare mapping)
    const docMachineBare = parseOKFDocument(`---\ntype: Test\nverified: { by: process:ci, at: '2026-10-28T12:00:00Z' }\n---`);
    assert.equal(deriveTrustTier(docMachineBare.frontmatter), "machine-confirmed");

    // 3. Machine-confirmed (list of agents/processes)
    const docMachineList = parseOKFDocument(`---
type: Test
verified:
  - by: reference_agent/v1
    at: '2026-10-28T12:00:00Z'
  - by: process:nightly-eval
    at: '2026-10-28T12:00:00Z'
---`);
    assert.equal(deriveTrustTier(docMachineList.frontmatter), "machine-confirmed");

    // 4. Human-reviewed (at least one human: actor)
    const docHuman = parseOKFDocument(`---
type: Test
verified:
  - by: reference_agent/v1
    at: '2026-10-28T12:00:00Z'
  - by: human:admin-alice
    at: '2026-10-28T12:00:00Z'
---`);
    assert.equal(deriveTrustTier(docHuman.frontmatter), "human-reviewed");
  });

  it("should evaluate staleness via stale_after per OKF v0.2 §5.5", () => {
    const fixedNow = new Date("2026-10-28T12:00:00Z");

    // Past date => stale
    const staleDoc = parseOKFDocument(`---\ntype: Test\nstale_after: '2026-10-01T00:00:00Z'\n---`);
    assert.equal(isConceptStale(staleDoc.frontmatter, fixedNow), true);

    // Future date => fresh
    const freshDoc = parseOKFDocument(`---\ntype: Test\nstale_after: '2026-12-31T00:00:00Z'\n---`);
    assert.equal(isConceptStale(freshDoc.frontmatter, fixedNow), false);

    // Missing => not stale
    const noStaleDoc = parseOKFDocument(`---\ntype: Test\n---`);
    assert.equal(isConceptStale(noStaleDoc.frontmatter, fixedNow), false);

    // Date-only without T is ignored (spec: not guessed at)
    const dateOnlyDoc = parseOKFDocument(`---\ntype: Test\nstale_after: '2026-10-01'\n---`);
    assert.equal(isConceptStale(dateOnlyDoc.frontmatter, fixedNow), false);
  });

  it("should serialize an OKFDocument back to valid Markdown with YAML frontmatter", () => {
    const original: OKFDocument = {
      frontmatter: {
        type: "Metric",
        title: "Active Users",
        tags: ["metrics", "users"],
      },
      body: "# Definition\nDaily active count.",
      trustTier: "unverified",
      isStale: false,
    };

    const serialized = serializeOKFDocument(original);
    assert.ok(serialized.startsWith("---\n"));
    assert.ok(serialized.includes("type: Metric"));
    assert.ok(serialized.includes("# Definition"));

    // Round-trip parse
    const reparsed = parseOKFDocument(serialized);
    assert.equal(reparsed.frontmatter.type, "Metric");
    assert.equal(reparsed.frontmatter.title, "Active Users");
    assert.deepEqual(reparsed.frontmatter.tags, ["metrics", "users"]);
    assert.equal(reparsed.body, "# Definition\nDaily active count.");
  });
});

describe("OKF Bundle Loader & Knowledge Hierarchy", () => {
  const bundlePath = path.resolve(process.cwd(), "../knowledge/bundle");

  it("should load the knowledge/bundle directory with valid hierarchy", () => {
    const bundle = loadOKFBundle(bundlePath, { strict: true });
    assert.ok(bundle.documents.size >= 5, "Expected at least 5 concept documents");
    assert.equal(bundle.okfVersion, "0.2");
    assert.ok(bundle.log?.includes("## 2026-10-28"));

    // Check presence of specific concepts
    assert.ok(bundle.documents.has("architecture/pipeline"));
    assert.ok(bundle.documents.has("architecture/storage"));
    assert.ok(bundle.documents.has("capabilities/supported_formats"));
    assert.ok(bundle.documents.has("capabilities/roles_and_permissions"));
    assert.ok(bundle.documents.has("policies/grounding_policy"));

    // Check presence of indices
    assert.ok(bundle.indices.has("index.md"));
    assert.ok(bundle.indices.has("architecture/index.md"));
    assert.ok(bundle.indices.has("capabilities/index.md"));
    assert.ok(bundle.indices.has("policies/index.md"));
  });

  it("should retrieve topic summaries from bundle", () => {
    const bundle = loadOKFBundle(bundlePath);
    const summaries = getBundleTopicSummaries(bundle);
    assert.equal(summaries.length, bundle.documents.size);

    const pipelineSummary = summaries.find((s) => s.conceptId === "architecture/pipeline");
    assert.ok(pipelineSummary);
    assert.equal(pipelineSummary?.type, "Architecture Component");
    assert.equal(pipelineSummary?.title, "RAG Pipeline Execution Flow");
    assert.ok(pipelineSummary?.tags.includes("pipeline"));
  });

  it("should find concept by conceptId, title, or tag", () => {
    const bundle = loadOKFBundle(bundlePath);

    // 1. By ID
    const byId = findConcept(bundle, "architecture/storage");
    assert.ok(byId);
    assert.equal(byId?.frontmatter.title, "PostgreSQL and pgvector Storage");

    // 2. By basename
    const byBasename = findConcept(bundle, "storage");
    assert.ok(byBasename);
    assert.equal(byBasename?.conceptId, "architecture/storage");

    // 3. By exact title
    const byTitle = findConcept(bundle, "Supported Ingestion Formats");
    assert.ok(byTitle);
    assert.equal(byTitle?.conceptId, "capabilities/supported_formats");

    // 4. By tag
    const byTag = findConcept(bundle, "rbac");
    assert.ok(byTag);
    assert.equal(byTag?.conceptId, "capabilities/roles_and_permissions");

    // 5. Non-existent returns undefined
    const notFound = findConcept(bundle, "non_existent_topic");
    assert.equal(notFound, undefined);
  });
});

describe("Query Intent Router & Routing Interface", () => {
  const router = defaultQueryRouter;

  it("should classify conversational greetings as 'greeting'", () => {
    const greetings = ["hello", "Hi", "hey!", "good morning", "thanks", "who are you?", "what can you do"];
    for (const q of greetings) {
      const decision = router.classify(q);
      assert.equal(decision.intent, "greeting", `Expected '${q}' to be greeting`);
      assert.equal(decision.suggestedAction, "respond_conversational");
      assert.ok(decision.confidence >= 0.9);
    }
  });

  it("should classify system architecture and capabilities questions as 'okf_topic'", () => {
    const okfQueries = [
      { q: "How does the RAG pipeline execution flow work?", expectedId: "architecture/pipeline" },
      { q: "Explain the pgvector storage schema and vector dimensions", expectedId: "architecture/storage" },
      { q: "What file formats can I upload?", expectedId: "capabilities/supported_formats" },
      { q: "What are the roles and permissions for administrators?", expectedId: "capabilities/roles_and_permissions" },
      { q: "What is the grounding policy and sufficiency threshold?", expectedId: "policies/grounding_policy" },
    ];

    for (const { q, expectedId } of okfQueries) {
      const decision = router.classify(q);
      assert.equal(decision.intent, "okf_topic", `Expected '${q}' to be okf_topic`);
      assert.equal(decision.suggestedAction, "lookup_okf");
      assert.equal(decision.matchedConceptId, expectedId);
      assert.ok(decision.confidence >= 0.8);
    }
  });

  it("should classify explicit document questions as 'document_rag'", () => {
    const docQueries = [
      "In the uploaded document, what was the total revenue?",
      "According to the contract, what is the termination clause in section 4?",
      "From the uploaded PDF report, summarize the main findings",
      "What does page 12 of the file say about compliance?",
    ];

    for (const q of docQueries) {
      const decision = router.classify(q);
      assert.equal(decision.intent, "document_rag", `Expected '${q}' to be document_rag`);
      assert.equal(decision.suggestedAction, "retrieve_documents");
      assert.ok(decision.confidence >= 0.8);
    }
  });

  it("should classify unrelated general knowledge questions as 'out_of_scope'", () => {
    const outQueries = [
      "What is the capital of France?",
      "Who won the 1994 FIFA World Cup?",
      "Write a poem about the sunrise",
      "What is the weather in Tokyo?",
      "Solve this math equation: d/dx(sin(x))",
    ];

    for (const q of outQueries) {
      const decision = router.classify(q);
      assert.equal(decision.intent, "out_of_scope", `Expected '${q}' to be out_of_scope`);
      assert.equal(decision.suggestedAction, "refuse_out_of_scope");
      assert.ok(decision.confidence >= 0.85);
    }
  });

  it("should classify mixed or ambiguous queries as 'ambiguous_mixed'", () => {
    // 1. Empty string
    const empty = router.classify("");
    assert.equal(empty.intent, "ambiguous_mixed");
    assert.equal(empty.suggestedAction, "clarify");

    // 2. Greeting mixed with document request
    const mixed = router.classify("Hello, in the uploaded report what is the net income?");
    assert.equal(mixed.intent, "ambiguous_mixed");
    assert.equal(mixed.suggestedAction, "retrieve_documents");

    // 3. Single punctuation or very short non-greeting
    const ambiguousShort = router.classify("???");
    assert.equal(ambiguousShort.intent, "ambiguous_mixed");
    assert.equal(ambiguousShort.suggestedAction, "clarify");
  });

  it("should leverage an active bundle to classify custom topic terms", () => {
    const bundlePath = path.resolve(process.cwd(), "../knowledge/bundle");
    const bundle = loadOKFBundle(bundlePath);

    const customQuery = "Tell me about RAG Pipeline Execution Flow";
    const decision = router.classify(customQuery, { activeBundle: bundle });
    assert.equal(decision.intent, "okf_topic");
    assert.equal(decision.matchedConceptId, "architecture/pipeline");
  });
});
