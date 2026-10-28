/**
 * Type contracts and data structures for Open Knowledge Format (OKF v0.2)
 * and query intent routing.
 */

export type TrustTier = "unverified" | "machine-confirmed" | "human-reviewed";

export type ConceptStatus = "draft" | "stable" | "deprecated";

export interface OKFSource {
  id?: string | undefined;
  resource: string;
  title?: string | undefined;
  author?: string | undefined;
  usage_count?: number | undefined;
  last_modified?: string | undefined;
}

export interface OKFVerificationEvent {
  by: string;
  at: string;
}

export interface OKFGenerationInfo {
  by: string;
  at: string;
}

export interface OKFFrontmatter {
  type: string;
  title?: string | undefined;
  description?: string | undefined;
  resource?: string | undefined;
  tags?: string[] | undefined;
  sources?: OKFSource[] | undefined;
  usage_window?: { from?: string | undefined; to?: string | undefined } | undefined;
  generated?: OKFGenerationInfo | undefined;
  verified?: OKFVerificationEvent[] | OKFVerificationEvent | undefined;
  status?: ConceptStatus | undefined;
  stale_after?: string | undefined;
  [key: string]: unknown;
}

export interface OKFDocument {
  frontmatter: OKFFrontmatter;
  body: string;
  filePath?: string | undefined;
  conceptId?: string | undefined;
  trustTier: TrustTier;
  isStale: boolean;
}

export interface ValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
}

export interface OKFBundle {
  bundlePath: string;
  okfVersion?: string | undefined;
  documents: Map<string, OKFDocument>;
  indices: Map<string, string>;
  log?: string | undefined;
}

/**
 * Pre-retrieval routing intent classification.
 */
export type QueryRouteIntent =
  | "greeting"
  | "okf_topic"
  | "document_rag"
  | "out_of_scope"
  | "ambiguous_mixed";

export type RouteSuggestedAction =
  | "respond_conversational"
  | "lookup_okf"
  | "retrieve_documents"
  | "refuse_out_of_scope"
  | "clarify";

export interface RouteDecision {
  intent: QueryRouteIntent;
  confidence: number;
  matchedConceptId?: string | undefined;
  matchedTopicTitle?: string | undefined;
  reasoning: string;
  suggestedAction: RouteSuggestedAction;
}

export interface RouterOptions {
  activeBundle?: OKFBundle | undefined;
}

export interface QueryRouter {
  classify(query: string, options?: RouterOptions): Promise<RouteDecision> | RouteDecision;
}
