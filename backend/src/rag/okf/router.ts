import path from "node:path";
import type { RouteDecision, RouterOptions, QueryRouter } from "./types.js";

const GREETING_REGEX =
  /^(hello|hi|hey|greetings|good\s+(morning|afternoon|evening)|howdy|sup|yo)(\s+there)?[\s!.?]*$|^(thanks|thank\s+you|who\s+are\s+you|what\s+are\s+you|what\s+can\s+you\s+do)[\s!.?]*$/i;

const DOCUMENT_PATTERNS = [
  /\b(in\s+the|according\s+to\s+the|from\s+the|within\s+the)\s+(document|file|pdf|docx|txt|report|contract|manual|paper|upload)/i,
  /\b(uploaded\s+(document|file|report|pdf|docx|txt))\b/i,
  /\b(page\s+\d+|section\s+\d+|clause\s+\d+|table\s+\d+)\b/i,
  /\b(document|file)\s+id\b/i,
];

const OUT_OF_SCOPE_PATTERNS = [
  /\b(capital\s+of\s+[a-z]+|who\s+won\s+the|fifa\s+world\s+cup|presidential\s+election)\b/i,
  /\b(write\s+(a\s+)?(poem|song|story|joke|recipe)|tell\s+me\s+a\s+joke)\b/i,
  /\b(weather\s+in|forecast\s+for|stock\s+price\s+of)\b/i,
  /\b(solve\s+this\s+(math|equation|derivative|integral)|d\/dx)\b/i,
];

const TOPIC_MAP: Array<{ conceptId: string; title: string; patterns: RegExp[] }> = [
  {
    conceptId: "architecture/pipeline",
    title: "RAG Pipeline Execution Flow",
    patterns: [
      /\b(rag\s+pipeline|pipeline\s+flow|ingestion\s+pipeline|how\s+does\s+(the\s+)?pipeline\s+work|execution\s+flow)\b/i,
      /\b(structural\s+chunking|sentence\s+splitter|llamaparse|layout\s+parsing|citation\s+mapping)\b/i,
    ],
  },
  {
    conceptId: "architecture/storage",
    title: "PostgreSQL and pgvector Storage",
    patterns: [
      /\b(pgvector|vector\s+(dimension|dimensions|storage|indexing)|512\s+dim)/i,
      /\b(postgresql|supabase|drizzle(\s+orm)?|schema\s+contract|database\s+schema|document_chunks)\b/i,
    ],
  },
  {
    conceptId: "capabilities/supported_formats",
    title: "Supported Ingestion Formats",
    patterns: [
      /\b(supported\s+formats?|supported\s+files?|file\s+formats?|what\s+(file\s+)?formats?\s+(can|do|are)|what\s+files?\s+can\s+i\s+upload|supported\s+extensions?)/i,
      /\b(upload\s+limits?|max\s+file\s+size|batch\s+upload|25\s*mb|active\s+document\s+limit|10\s+documents)\b/i,
    ],
  },
  {
    conceptId: "capabilities/roles_and_permissions",
    title: "Roles and Access Control",
    patterns: [
      /\b(rbac|roles?\s+and\s+permissions?|user\s+roles?|access\s+control|permissions?\s+matrix)\b/i,
      /\b(super_admin|admin\s+role|user\s+role|who\s+can\s+(upload|delete|manage))\b/i,
    ],
  },
  {
    conceptId: "policies/grounding_policy",
    title: "Grounding Safeguards and Refusal Policy",
    patterns: [
      /\b(grounding(\s+policy|\s+safeguard)?|refusal\s+policy|hallucination\s+prevention)\b/i,
      /\b(sufficiency(\s+score|\s+gate|\s+threshold)?|0\.65|insufficient_evidence)\b/i,
    ],
  },
];

export class RuleBasedQueryRouter implements QueryRouter {
  classify(query: string, options?: RouterOptions): RouteDecision {
    const q = query.trim();
    if (!q) {
      return { intent: "ambiguous_mixed", confidence: 1.0, reasoning: "Query is empty.", suggestedAction: "clarify" };
    }

    if (GREETING_REGEX.test(q)) {
      return {
        intent: "greeting",
        confidence: 0.95,
        reasoning: "Conversational greeting.",
        suggestedAction: "respond_conversational",
      };
    }

    const isGreetingPrefix = /^(hello|hi|hey|good\s+(morning|afternoon|evening))\b/i.test(q);
    const isDocQuery = DOCUMENT_PATTERNS.some((p) => p.test(q));

    // Match OKF topic patterns
    let topic = TOPIC_MAP.find((t) => t.patterns.some((p) => p.test(q)));

    // Match active bundle concepts if provided (whole-word matching)
    if (!topic && options?.activeBundle) {
      for (const [id, doc] of options.activeBundle.documents) {
        const title = doc.frontmatter.title;
        const titleMatch = title && new RegExp(`\\b${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(q);
        const tagMatch = doc.frontmatter.tags?.some((t) =>
          new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(q)
        );
        if (titleMatch || tagMatch) {
          topic = { conceptId: id, title: doc.frontmatter.title || path.basename(id), patterns: [] };
          break;
        }
      }
    }

    if (isGreetingPrefix && (isDocQuery || topic)) {
      return {
        intent: "ambiguous_mixed",
        confidence: 0.85,
        reasoning: "Greeting mixed with substantive query.",
        suggestedAction: topic ? "lookup_okf" : "retrieve_documents",
        ...(topic ? { matchedConceptId: topic.conceptId, matchedTopicTitle: topic.title } : {}),
      };
    }

    if (isDocQuery) {
      return {
        intent: "document_rag",
        confidence: 0.9,
        reasoning: "Explicit reference to uploaded document or page.",
        suggestedAction: "retrieve_documents",
      };
    }

    if (topic) {
      return {
        intent: "okf_topic",
        confidence: 0.9,
        matchedConceptId: topic.conceptId,
        matchedTopicTitle: topic.title,
        reasoning: `Matches system topic: ${topic.title}.`,
        suggestedAction: "lookup_okf",
      };
    }

    if (OUT_OF_SCOPE_PATTERNS.some((p) => p.test(q))) {
      return {
        intent: "out_of_scope",
        confidence: 0.9,
        reasoning: "General knowledge question outside system scope.",
        suggestedAction: "refuse_out_of_scope",
      };
    }

    if (q.split(/\s+/).length <= 1 && q.length < 4) {
      return { intent: "ambiguous_mixed", confidence: 0.7, reasoning: "Query is too brief.", suggestedAction: "clarify" };
    }

    return {
      intent: "document_rag",
      confidence: 0.75,
      reasoning: "Domain query routed to document retrieval.",
      suggestedAction: "retrieve_documents",
    };
  }
}

export const defaultQueryRouter = new RuleBasedQueryRouter();
