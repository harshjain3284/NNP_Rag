import fs from "node:fs";
import path from "node:path";
import { parseOKFDocument, validateOKFDocument } from "./parser.js";
import type { OKFBundle, OKFDocument } from "./types.js";

export interface LoadBundleOptions {
  strict?: boolean | undefined;
}

/**
 * Recursively scans and loads an OKF knowledge bundle from a directory tree into an in-memory bundle model.
 */
export const loadOKFBundle = (bundleDir: string, options?: LoadBundleOptions): OKFBundle => {
  const root = path.resolve(bundleDir);
  if (!fs.existsSync(root)) {
    throw new Error(`OKF Bundle directory does not exist: ${root}`);
  }

  const documents = new Map<string, OKFDocument>();
  const indices = new Map<string, string>();
  let rootLog: string | undefined;
  let okfVersion: string | undefined;

  const walk = (dir: string, rel: string = "") => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const relPath = (rel ? `${rel}/${entry.name}` : entry.name).replace(/\\/g, "/");

      if (entry.isDirectory()) {
        walk(full, relPath);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        const raw = fs.readFileSync(full, "utf-8");
        const isIndex = entry.name === "index.md";
        const isLog = entry.name === "log.md";
        const isRoot = rel === "";

        const doc = parseOKFDocument(raw, relPath);
        const resType = isIndex ? "index" : isLog ? "log" : false;
        const validation = validateOKFDocument(doc, { isReservedFile: resType, isRootIndex: isRoot });

        if (options?.strict && !validation.isValid) {
          throw new Error(`OKF validation failed for ${relPath}: ${validation.errors.join("; ")}`);
        }

        if (isIndex) {
          indices.set(relPath, raw);
          if (isRoot && doc.frontmatter.okf_version) {
            okfVersion = String(doc.frontmatter.okf_version);
          }
        } else if (isLog) {
          if (isRoot) rootLog = raw;
        } else {
          doc.conceptId = relPath.replace(/\.md$/, "");
          documents.set(doc.conceptId, doc);
        }
      }
    }
  };

  walk(root);

  const bundle: OKFBundle = { bundlePath: root, documents, indices };
  if (okfVersion !== undefined) bundle.okfVersion = okfVersion;
  if (rootLog !== undefined) bundle.log = rootLog;
  return bundle;
};

/**
 * Returns structured topic summaries across all concepts in the bundle.
 */
export const getBundleTopicSummaries = (bundle: OKFBundle) =>
  Array.from(bundle.documents.entries()).map(([conceptId, doc]) => ({
    conceptId,
    title: doc.frontmatter.title || path.basename(conceptId),
    type: doc.frontmatter.type,
    description: doc.frontmatter.description || "",
    tags: doc.frontmatter.tags || [],
  }));

/**
 * Searches for a concept by conceptId, basename, title, or tag.
 */
export const findConcept = (bundle: OKFBundle, term: string): OKFDocument | undefined => {
  const norm = term.trim().toLowerCase().replace(/\.md$/, "");
  if (!norm) return undefined;

  return (
    bundle.documents.get(norm) ||
    Array.from(bundle.documents.values()).find(
      (doc) =>
        (doc.conceptId && path.basename(doc.conceptId).toLowerCase() === norm) ||
        doc.frontmatter.title?.toLowerCase() === norm ||
        doc.frontmatter.tags?.some((t) => t.toLowerCase() === norm)
    )
  );
};
