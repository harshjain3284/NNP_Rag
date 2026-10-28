import yaml from "yaml";
import type {
  OKFDocument,
  OKFFrontmatter,
  OKFVerificationEvent,
  TrustTier,
  ValidationResult,
} from "./types.js";

const FRONTMATTER_DELIMITER = "---";

export class OKFParseError extends Error {
  constructor(message: string, public readonly filePath?: string | undefined) {
    super(filePath ? `${message} (in ${filePath})` : message);
    this.name = "OKFParseError";
  }
}

/**
 * Normalizes `verified` into an array per OKF v0.2 §5.2.
 */
export const normalizeVerified = (verified: OKFFrontmatter["verified"]): OKFVerificationEvent[] => {
  if (!verified) return [];
  if (Array.isArray(verified)) {
    return verified.filter((v): v is OKFVerificationEvent => typeof v?.by === "string" && typeof v?.at === "string");
  }
  if (
    typeof verified === "object" &&
    verified !== null &&
    "by" in verified &&
    "at" in verified &&
    typeof (verified as { by?: unknown }).by === "string" &&
    typeof (verified as { at?: unknown }).at === "string"
  ) {
    return [verified as OKFVerificationEvent];
  }
  return [];
};

/**
 * Derives trust tier per OKF v0.2 §5.3.
 */
export const deriveTrustTier = (fm: OKFFrontmatter): TrustTier => {
  const events = normalizeVerified(fm.verified);
  if (events.length === 0) return "unverified";
  return events.some((e) => e.by.startsWith("human:")) ? "human-reviewed" : "machine-confirmed";
};

/**
 * Checks staleness per OKF v0.2 §5.5 (requires ISO datetime with 'T').
 */
export const isConceptStale = (fm: OKFFrontmatter, now = new Date()): boolean => {
  const raw = fm.stale_after;
  if (!raw || typeof raw !== "string" || !raw.includes("T")) return false;
  const time = new Date(raw).getTime();
  return !Number.isNaN(time) && now.getTime() >= time;
};

/**
 * Parses raw file content into an OKFDocument.
 */
export const parseOKFDocument = (content: string, filePath?: string): OKFDocument => {
  const lines = content.split(/\r?\n/);
  const conceptId = filePath ? filePath.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\.md$/, "") : undefined;

  if (lines[0]?.trim() !== FRONTMATTER_DELIMITER) {
    return {
      frontmatter: { type: "" },
      body: content.trim(),
      filePath,
      conceptId,
      trustTier: "unverified",
      isStale: false,
    };
  }

  const endIdx = lines.slice(1).findIndex((l) => l.trim() === FRONTMATTER_DELIMITER);
  if (endIdx === -1) {
    throw new OKFParseError("Unterminated YAML frontmatter block", filePath);
  }

  const yamlText = lines.slice(1, endIdx + 1).join("\n");
  let parsed: unknown;
  try {
    parsed = yaml.parse(yamlText);
  } catch (err) {
    throw new OKFParseError(`Invalid YAML in frontmatter: ${err instanceof Error ? err.message : String(err)}`, filePath);
  }

  if (parsed !== null && parsed !== undefined && (typeof parsed !== "object" || Array.isArray(parsed))) {
    throw new OKFParseError("Frontmatter must be a YAML mapping (key-value dictionary)", filePath);
  }

  const frontmatter = (parsed ?? {}) as OKFFrontmatter;
  const body = lines.slice(endIdx + 2).join("\n").trim();

  return {
    frontmatter,
    body,
    filePath,
    conceptId,
    trustTier: deriveTrustTier(frontmatter),
    isStale: isConceptStale(frontmatter),
  };
};

/**
 * Validates an OKFDocument against OKF v0.2 conformance rules (§11).
 */
export const validateOKFDocument = (
  doc: OKFDocument,
  options?: { isReservedFile?: "index" | "log" | false | undefined; isRootIndex?: boolean | undefined }
): ValidationResult => {
  const errors: string[] = [];
  const warnings: string[] = [];
  const { isReservedFile, isRootIndex } = options ?? {};

  if (isReservedFile === "index") {
    if (!isRootIndex && Object.keys(doc.frontmatter).some((k) => k !== "type" || doc.frontmatter[k])) {
      errors.push("Subdirectory index.md files MUST NOT contain frontmatter (OKF v0.2 §8).");
    } else if (isRootIndex) {
      for (const k of Object.keys(doc.frontmatter).filter((k) => k !== "type" && k !== "okf_version")) {
        warnings.push(`Bundle-root index.md contains unconventional frontmatter key '${k}'.`);
      }
    }
    return { isValid: errors.length === 0, errors, warnings };
  }

  if (isReservedFile === "log") {
    if (Object.keys(doc.frontmatter).some((k) => k !== "type" || doc.frontmatter[k])) {
      errors.push("log.md files MUST NOT contain frontmatter (OKF v0.2 §9).");
    }
    if (doc.body && !/## \d{4}-\d{2}-\d{2}/.test(doc.body)) {
      warnings.push("log.md SHOULD contain chronological entries grouped by ISO 8601 date headings (## YYYY-MM-DD).");
    }
    return { isValid: errors.length === 0, errors, warnings };
  }

  // Concept document validation (Rule 2: non-empty type is required)
  if (!doc.frontmatter.type?.trim()) {
    errors.push("Missing required frontmatter key: 'type' is required for all concept files (OKF v0.2 §4.1, §11).");
  }

  if (doc.frontmatter.sources) {
    if (!Array.isArray(doc.frontmatter.sources)) {
      errors.push("'sources' frontmatter field must be a YAML sequence (list of sources).");
    } else {
      doc.frontmatter.sources.forEach((s, i) => {
        if (!s || typeof s !== "object" || !("resource" in s)) {
          errors.push(`sources[${i}] is missing the required 'resource' field (OKF v0.2 §5.1).`);
        }
      });
    }
  }

  return { isValid: errors.length === 0, errors, warnings };
};

/**
 * Serializes an OKFDocument back to string with YAML frontmatter.
 */
export const serializeOKFDocument = (doc: OKFDocument): string => {
  const fm = { ...doc.frontmatter };
  if (!fm.type && Object.keys(fm).length === 1) return `${doc.body}\n`;
  return `${FRONTMATTER_DELIMITER}\n${yaml.stringify(fm).trim()}\n${FRONTMATTER_DELIMITER}\n\n${doc.body}\n`;
};
