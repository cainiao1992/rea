import { compareUnicodeCodePoints } from "../domain/unicodeCodePointOrder.js";
import {
  createHistoricalSourceGraph,
  historicalSourceLanguages,
  historicalSourceManifests,
  historicalSourceParseFailureKey,
  type HistoricalSourceGraph,
  type HistoricalSourceGraphInput,
} from "../domain/referenceSourceGraph.js";
import { err, ok, type Result } from "../domain/result.js";
import { readReferenceSource } from "../reference/ReferenceSourceReader.js";
import type { ReferenceSourceEntryKind } from "../reference/ReferenceSourceReaderTypes.js";
import { parseReferenceSourceEntries } from "./ReferenceSourceImportEntries.js";
import { readReferenceSourceVcs } from "./ReferenceSourceVcsAdapter.js";
import {
  type ReferenceSourceImportError,
  type ReferenceSourceImportOptions,
} from "./ReferenceSourceImportTypes.js";
import {
  prepareReferenceSourceImport,
  type PreparedReferenceSourceImport,
} from "./ReferenceSourceImportPolicy.js";

const failure = (
  code: ReferenceSourceImportError["code"],
  message: string,
): ReferenceSourceImportError => ({
  tag: "reference-source-import",
  code,
  message,
});

const cancelled = (): ReferenceSourceImportError =>
  failure("cancelled", "Reference source import cancelled");

const isAborted = (signal?: AbortSignal): boolean => signal?.aborted === true;

const relationshipKey = (
  relationship: HistoricalSourceGraphInput["relationships"][number],
): string =>
  `${relationship.from_path}\u0000${relationship.to}\u0000${relationship.kind}\u0000${relationship.resolution}\u0000${relationship.parse_state}`;

const deduplicateRelationships = (
  relationships: HistoricalSourceGraphInput["relationships"],
): HistoricalSourceGraphInput["relationships"] => {
  const seen = new Set<string>();
  const result: HistoricalSourceGraphInput["relationships"] = [];
  for (const relationship of relationships) {
    const key = relationshipKey(relationship);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(relationship);
  }
  return result;
};

/** Sort parse failures deterministically while retaining distinct reasons. */
export const normalizeHistoricalSourceParseFailures = (
  failures: HistoricalSourceGraphInput["parse_failures"],
): HistoricalSourceGraphInput["parse_failures"] =>
  [...failures]
    .sort((left, right) =>
      compareUnicodeCodePoints(
        historicalSourceParseFailureKey(left),
        historicalSourceParseFailureKey(right),
      ),
    )
    .filter((value, index, array) => {
      if (index === 0) return true;
      const previous = array[index - 1];
      return (
        previous === undefined ||
        historicalSourceParseFailureKey(value) !==
          historicalSourceParseFailureKey(previous)
      );
    });

const buildProvenance = (
  options: ReferenceSourceImportOptions,
): HistoricalSourceGraphInput["provenance"] => ({
  importer: options.importer ?? "rea-reference-source-import",
  importer_version: options.importerVersion ?? null,
  caller: options.caller,
});

const deriveInventoryState = (
  input: Pick<
    HistoricalSourceGraphInput,
    | "entries"
    | "relationships"
    | "parse_failures"
    | "exclusions"
    | "limitations"
  >,
): "complete" | "partial" | "unknown" => {
  if (input.limitations.length > 0) return "partial";
  if (input.exclusions.length > 0) return "partial";
  if (input.parse_failures.length > 0) return "partial";
  const partialEntry = input.entries.some(
    (entry) =>
      entry.limitations.length > 0 ||
      (entry.kind === "file" && entry.content_state !== "hashed") ||
      (entry.kind === "directory" && entry.tree_state !== "enumerated") ||
      (entry.kind === "symlink" && entry.target_state !== "internal"),
  );
  if (partialEntry) return "partial";
  const partialRelationship = input.relationships.some(
    ({ parse_state, resolution }) =>
      parse_state !== "parsed" ||
      ["unresolved", "unknown"].includes(resolution),
  );
  if (partialRelationship) return "partial";
  return "complete";
};

const sortExclusions = (
  exclusions: HistoricalSourceGraphInput["exclusions"],
): HistoricalSourceGraphInput["exclusions"] =>
  [...exclusions].sort((left, right) => {
    const byPath = compareUnicodeCodePoints(left.path, right.path);
    if (byPath !== 0) return byPath;
    const byReason = compareUnicodeCodePoints(left.reason, right.reason);
    if (byReason !== 0) return byReason;
    return compareUnicodeCodePoints(
      "pattern" in left ? left.pattern : "",
      "pattern" in right ? right.pattern : "",
    );
  });

const createShouldExclude =
  (
    exclusions: HistoricalSourceGraphInput["exclusions"],
    secrets: PreparedReferenceSourceImport["secrets"],
    ignored: PreparedReferenceSourceImport["ignored"],
  ): ((path: string, kind: ReferenceSourceEntryKind) => boolean) =>
  (path, kind) => {
    const patternPath = kind === "directory" ? `${path}/` : path;
    const secretMatch = secrets.test(patternPath);
    if (secretMatch.ignored) {
      if (!secretMatch.rule)
        throw new Error(`Ignored secret path has no matching rule: ${path}`);
      exclusions.push({
        path,
        reason: "configured-secret",
        pattern: secretMatch.rule.pattern,
      });
      return true;
    }
    const match = ignored.test(patternPath);
    if (!match.ignored) return false;
    if (!match.rule)
      throw new Error(`Ignored path has no matching rule: ${path}`);
    const reason = match.rule.mark;
    if (
      reason !== "project-ignored" &&
      reason !== "default-ignored" &&
      reason !== "caller-excluded"
    )
      throw new Error(`Ignored path has unknown rule origin: ${path}`);
    exclusions.push({ path, reason, pattern: match.rule.pattern });
    return true;
  };

/**
 * Import a reference source directory into a committed historical source graph.
 *
 * The import is deterministic, parallel-safe, and never executes source, hooks,
 * git subprocesses, or network requests. Paths explicitly excluded by the
 * caller's reference-source policy are omitted from the graph.
 */
export const importReferenceSource = async (
  options: ReferenceSourceImportOptions,
): Promise<Result<HistoricalSourceGraph, ReferenceSourceImportError>> => {
  if (isAborted(options.signal)) return err(cancelled());
  const prepared = await prepareReferenceSourceImport(options);
  if (!prepared.ok) return prepared;
  const { ignored, root, secrets } = prepared.value;
  if (isAborted(options.signal)) return err(cancelled());

  const exclusions: HistoricalSourceGraphInput["exclusions"] = [];
  const shouldExclude = createShouldExclude(exclusions, secrets, ignored);

  const [readResult, vcs] = await Promise.all([
    readReferenceSource(root, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      shouldExclude,
    }),
    readReferenceSourceVcs(root, options.signal),
  ]);

  if (!readResult.ok) {
    const error = readResult.error;
    if (error.code === "cancelled") return err(cancelled());
    if (error.code === "unsupported")
      return err(failure("unsupported", error.message));
    return err(failure("io", error.message));
  }

  if (isAborted(options.signal)) return err(cancelled());

  const read = readResult.value;
  const filePaths = new Set(
    read.entries
      .filter((entry) => entry.status === "read" && entry.kind === "file")
      .map((entry) => entry.path),
  );

  const { entries, relationships, parseFailures, limitations } =
    parseReferenceSourceEntries(read, filePaths, options.signal);

  if (isAborted(options.signal)) return err(cancelled());

  const uniqueRelationships = deduplicateRelationships(relationships);
  const uniqueFailures = normalizeHistoricalSourceParseFailures(parseFailures);

  const sortedEntries = [...entries].sort((left, right) =>
    compareUnicodeCodePoints(left.path, right.path),
  );
  const sortedExclusions = sortExclusions(exclusions);
  const sortedLimitations = [...limitations].sort(compareUnicodeCodePoints);

  const input: HistoricalSourceGraphInput = {
    schema: "HistoricalSourceGraph",
    authority: "historical-reference",
    root_alias: "$REFERENCE_ROOT",
    inventory_state: deriveInventoryState({
      entries: sortedEntries,
      relationships: uniqueRelationships,
      parse_failures: uniqueFailures,
      exclusions: sortedExclusions,
      limitations: sortedLimitations,
    }),
    entries: sortedEntries,
    relationships: uniqueRelationships.sort((left, right) =>
      compareUnicodeCodePoints(relationshipKey(left), relationshipKey(right)),
    ),
    parse_failures: uniqueFailures,
    exclusions: sortedExclusions,
    languages: historicalSourceLanguages(sortedEntries),
    manifests: historicalSourceManifests(sortedEntries),
    vcs,
    provenance: buildProvenance(options),
    limitations: sortedLimitations,
  };

  try {
    return ok(createHistoricalSourceGraph(input));
  } catch (cause: unknown) {
    return err(
      failure(
        "parse",
        cause instanceof Error ? cause.message : "Graph failed validation",
      ),
    );
  }
};
