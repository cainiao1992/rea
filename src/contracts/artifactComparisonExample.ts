import { createHash } from "node:crypto";

import canonicalize from "canonicalize";

import { createEvidence } from "../domain/evidence.js";
import { jsonValueSchema } from "../domain/jsonValue.js";

const inventory = (digit: string) => {
  const sha = digit.repeat(64);
  const artifactId = `art_${digestCanonical({ sha256: sha })}`;
  const occurrenceId = `occ_${digestCanonical({ root: artifactId })}`;
  const nodes = [
    {
      artifact_id: artifactId,
      kind: "resource",
      format: "file",
      sha256: sha,
      size: 1,
      media_type: null,
      architecture: null,
      executable: false,
      content_state: "materialized",
      limitations: [],
    },
  ];
  const occurrences = [
    {
      occurrence_id: occurrenceId,
      artifact_id: artifactId,
      parent_occurrence_id: null,
      logical_path: ".",
      entry_kind: "file",
      declared_size: 1,
      compressed_size: null,
      executable: false,
      encrypted: false,
      hash_status: "verified",
      source_location: null,
      limitations: [],
    },
  ];
  const graphSha256 = digestCanonical({
    nodes,
    occurrences,
    edges: [],
    integrity_contradictions: [],
  });
  return jsonValueSchema.parse({
    manifest: {
      manifest_id: `agm_${digestCanonical({
        root_artifact_id: artifactId,
        graph_sha256: graphSha256,
      })}`,
      root_artifact_id: artifactId,
      root_sha256: sha,
      root_format: "file",
      graph_sha256: graphSha256,
      node_count: nodes.length,
      occurrence_count: occurrences.length,
      edge_count: 0,
    },
    nodes,
    occurrences,
    edges: [],
    provenance: [],
    limitations: [],
  });
};

const digestCanonical = (value: unknown): string => {
  const encoded = canonicalize(value);
  if (encoded === undefined)
    throw new TypeError("Artifact example is not canonical JSON");
  return createHash("sha256").update(encoded).digest("hex");
};

const provider = {
  id: "rea-artifact",
  name: "REA artifact graph",
  version: "1",
} as const;

/** Canonical complete inputs used to advertise artifact comparison. */
export const ARTIFACT_COMPARISON_EXAMPLE = {
  left: createEvidence(
    { path: "fixture-left", sha256: "0".repeat(64), format: "file" },
    provider,
    {
      operation: "inventory_artifact",
      parameters: {},
      result: inventory("0"),
      confidence: "observed",
      authority: "shipped-artifact",
    },
  ),
  right: createEvidence(
    { path: "fixture-right", sha256: "1".repeat(64), format: "file" },
    provider,
    {
      operation: "inventory_artifact",
      parameters: {},
      result: inventory("1"),
      confidence: "observed",
      authority: "shipped-artifact",
    },
  ),
} as const;
