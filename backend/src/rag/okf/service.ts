import fs from "node:fs";
import path from "node:path";
import { loadOKFBundle, findConcept } from "./loader.js";
import { defaultQueryRouter } from "./router.js";
import type { OKFBundle, OKFDocument, QueryRouter, RouteDecision } from "./types.js";
import type { Citation } from "../generation/types.js";

export const GREETING_RESPONSE =
  "Hello! I am your AI assistant for NNT RAG. You can ask me questions about your uploaded documents, system architecture, supported formats, or policies. How can I help you today?";

export const OUT_OF_SCOPE_REFUSAL_MESSAGE =
  "I cannot answer this question. My responses must be strictly grounded in authorized uploaded documents or system knowledge.";

export const OUT_OF_SCOPE_REFUSAL_REASON =
  "Question is outside authorized document and system scope.";

export interface RoutedChatResult {
  answer: string;
  evidenceSufficient: boolean;
  refusalReason?: string | undefined;
  citations: Citation[];
  modelName: string;
  providerName: string;
}

export interface QueryRoutingOutcome {
  decision: RouteDecision;
  handledDirectly: boolean;
  result?: RoutedChatResult | undefined;
}

export interface RouteChatQueryOptions {
  documentId?: string | undefined;
  bundle?: OKFBundle | undefined;
  router?: QueryRouter | undefined;
}

/**
 * Resolves the path to the OKF knowledge bundle directory.
 */
export const resolveBundlePath = (custom?: string): string => {
  const candidates = [
    custom,
    process.env.OKF_BUNDLE_PATH,
    path.resolve(process.cwd(), "knowledge/bundle"),
    path.resolve(process.cwd(), "../knowledge/bundle"),
  ].filter((p): p is string => Boolean(p && fs.existsSync(p)));

  return candidates[0] ?? path.resolve(process.cwd(), "../knowledge/bundle");
};

let cachedBundle: OKFBundle | null = null;

/**
 * Returns the cached active OKF bundle, lazily loading it if needed.
 */
export const getActiveOKFBundle = (dir?: string): OKFBundle => {
  if (!cachedBundle || dir) {
    const bundle = loadOKFBundle(resolveBundlePath(dir));
    if (!dir) cachedBundle = bundle;
    return bundle;
  }
  return cachedBundle;
};

export const setCachedOKFBundle = (bundle: OKFBundle | null): void => {
  cachedBundle = bundle;
};

/**
 * Formats a clean answer string directly from an OKF concept document.
 */
export const formatOKFAnswer = (doc: OKFDocument): string => {
  const { title, description } = doc.frontmatter;
  const header = title && !doc.body.startsWith(`# ${title}`) ? `## ${title}\n\n` : "";
  const desc = description ? `*${description}*\n\n` : "";
  return `${header}${desc}${doc.body.trim()}`.trim();
};

/**
 * Creates a Citation referencing an OKF concept document.
 */
export const createOKFCitation = (doc: OKFDocument): Citation => {
  const id = doc.conceptId || "concept";
  return {
    documentId: "okf-bundle",
    filename: doc.filePath || `${id}.md`,
    pageNumber: null,
    chunkIndex: 0,
    chunkId: `okf:${id}`,
    similarity: 1.0,
    snippet: doc.body.trim() || doc.frontmatter.description || "",
  };
};

const buildOKFResult = (concept: OKFDocument): RoutedChatResult => ({
  answer: formatOKFAnswer(concept),
  evidenceSufficient: true,
  citations: [createOKFCitation(concept)],
  modelName: "okf-direct",
  providerName: "okf-bundle",
});

/**
 * Pre-retrieval routing gate: directly answers greetings, OKF topics, and refusals,
 * or routes domain/document queries to the authorized pgvector RAG pipeline.
 */
export const routeChatQuery = async (
  query: string,
  options?: RouteChatQueryOptions
): Promise<QueryRoutingOutcome> => {
  if (options?.documentId) {
    return {
      decision: {
        intent: "document_rag",
        confidence: 1.0,
        reasoning: "Explicit documentId specified in request.",
        suggestedAction: "retrieve_documents",
      },
      handledDirectly: false,
    };
  }

  const bundle = options?.bundle ?? getActiveOKFBundle();
  const router = options?.router ?? defaultQueryRouter;
  const decision = await router.classify(query.trim(), { activeBundle: bundle });

  switch (decision.intent) {
    case "greeting":
      return {
        decision,
        handledDirectly: true,
        result: {
          answer: GREETING_RESPONSE,
          evidenceSufficient: true,
          citations: [],
          modelName: "conversational",
          providerName: "system",
        },
      };

    case "okf_topic": {
      const concept = decision.matchedConceptId ? findConcept(bundle, decision.matchedConceptId) : undefined;
      return concept
        ? { decision, handledDirectly: true, result: buildOKFResult(concept) }
        : { decision, handledDirectly: false };
    }

    case "out_of_scope":
      return {
        decision,
        handledDirectly: true,
        result: {
          answer: OUT_OF_SCOPE_REFUSAL_MESSAGE,
          evidenceSufficient: false,
          refusalReason: OUT_OF_SCOPE_REFUSAL_REASON,
          citations: [],
          modelName: "system",
          providerName: "system",
        },
      };

    case "ambiguous_mixed": {
      if (decision.suggestedAction === "lookup_okf" && decision.matchedConceptId) {
        const concept = findConcept(bundle, decision.matchedConceptId);
        if (concept) return { decision, handledDirectly: true, result: buildOKFResult(concept) };
      }
      return { decision, handledDirectly: false };
    }

    case "document_rag":
    default:
      return { decision, handledDirectly: false };
  }
};
