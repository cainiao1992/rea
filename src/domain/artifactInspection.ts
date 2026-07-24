import { createHash } from "node:crypto";

import canonicalize from "canonicalize";
import { z } from "zod";

import {
  artifactInventoryResultSchema,
  type ArtifactInventoryResult,
} from "./artifactGraph.js";
import { evidenceSchema, parseEvidence, type Evidence } from "./evidence.js";
import { jsonValueSchema } from "./jsonValue.js";

const boundedTextSchema = z.string().min(1).max(4_096);
const evidenceIdSchema = z.string().regex(/^ev_[a-f0-9]{64}$/u);
const artifactIdSchema = z.string().regex(/^art_[a-f0-9]{64}$/u);

const inspectionLimitsSchema = z.strictObject({
  max_observations: z.number().int().min(1).max(500).default(100),
  max_relationships: z.number().int().min(1).max(500).default(100),
  max_hypotheses: z.number().int().min(1).max(100).default(20),
  max_unexplored_branches: z.number().int().min(1).max(100).default(20),
  max_next_probes: z.number().int().min(1).max(50).default(20),
  max_substeps: z.literal(1).default(1),
});

export const artifactInspectionLimitsSchema = inspectionLimitsSchema;

const inspectionObservationSchema = z.strictObject({
  observation_id: z.string().regex(/^aio_[a-f0-9]{64}$/u),
  kind: z.enum(["root-manifest", "artifact", "occurrence", "integrity"]),
  subject: boundedTextSchema,
  value: jsonValueSchema,
  evidence_id: evidenceIdSchema,
});

const inspectionRelationshipSchema = z.strictObject({
  relationship_id: z.string().regex(/^air_[a-f0-9]{64}$/u),
  relation: z.enum([
    "contains",
    "extracts",
    "slice-of",
    "embeds",
    "loads",
    "maps-source",
    "derived-from",
  ]),
  source_artifact_id: artifactIdSchema,
  target_artifact_id: artifactIdSchema,
  occurrence_id: z.string().regex(/^occ_[a-f0-9]{64}$/u),
  logical_path: boundedTextSchema.nullable(),
  evidence_id: evidenceIdSchema,
});

const inspectionHypothesisSchema = z.strictObject({
  hypothesis_id: z.string().regex(/^aih_[a-f0-9]{64}$/u),
  statement: boundedTextSchema,
  confidence: z.enum(["medium", "low"]),
  basis_evidence_ids: z.array(evidenceIdSchema).min(1).max(8),
  limitation: boundedTextSchema,
});

const inspectionContradictionSchema = z.strictObject({
  contradiction_id: z.string().regex(/^aic_[a-f0-9]{64}$/u),
  statement: boundedTextSchema,
  occurrence_id: z.string().regex(/^occ_[a-f0-9]{64}$/u),
  declared_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  observed_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  evidence_id: evidenceIdSchema,
});

const nextProbeSchema = z.strictObject({
  operation: z.string().min(1).max(128),
  rationale: boundedTextSchema,
  authority: z.enum([
    "artifact-bytes",
    "managed-static-analysis",
    "native-analysis-provider",
    "ast-static-analysis",
  ]),
});

const unexploredBranchSchema = z.strictObject({
  branch_id: z.string().regex(/^aib_[a-f0-9]{64}$/u),
  reason: z.enum([
    "page-limit",
    "format-specific-analysis-required",
    "unknown-format",
  ]),
  detail: boundedTextSchema,
  next_probe: nextProbeSchema.nullable(),
  evidence_id: evidenceIdSchema,
});

/** Provider-neutral inspection result with its atomic source Evidence. */
export const artifactInspectionResultSchema = z.strictObject({
  schema_version: z.literal(1),
  inspection_id: z.string().regex(/^ai_[a-f0-9]{64}$/u),
  subject: z.strictObject({
    manifest_id: z.string().regex(/^agm_[a-f0-9]{64}$/u),
    root_artifact_id: artifactIdSchema,
    root_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    root_format: z.string().min(1).max(128),
  }),
  substeps: z
    .array(
      z.strictObject({
        substep_id: z.string().regex(/^ais_[a-f0-9]{64}$/u),
        operation: z.literal("inventory_artifact"),
        status: z.literal("completed"),
        evidence_id: evidenceIdSchema,
        evidence: evidenceSchema,
      }),
    )
    .min(1)
    .max(1),
  observations: z.array(inspectionObservationSchema).max(500),
  derived_relationships: z.array(inspectionRelationshipSchema).max(500),
  hypotheses: z.array(inspectionHypothesisSchema).max(100),
  contradictions: z.array(inspectionContradictionSchema).max(100),
  unexplored_branches: z.array(unexploredBranchSchema).max(100),
  next_probes: z.array(nextProbeSchema).max(50),
  coverage: z.strictObject({
    status: z.enum(["complete-within-substeps", "partial", "truncated"]),
    substeps_completed: z.literal(1),
    observations_retained: z.number().int().min(0),
    observations_omitted: z.number().int().min(0),
    relationships_retained: z.number().int().min(0),
    relationships_omitted: z.number().int().min(0),
    hypotheses_retained: z.number().int().min(0),
    hypotheses_omitted: z.number().int().min(0),
    unexplored_branches_retained: z.number().int().min(0),
    unexplored_branches_omitted: z.number().int().min(0),
    next_probes_retained: z.number().int().min(0),
    next_probes_omitted: z.number().int().min(0),
  }),
  evidence_links: z.array(evidenceIdSchema).min(1).max(1),
  limitations: z.array(boundedTextSchema).max(1_000),
});

export type ArtifactInspectionLimits = z.infer<
  typeof artifactInspectionLimitsSchema
>;
export type ArtifactInspectionResult = z.infer<
  typeof artifactInspectionResultSchema
>;

/** Project one successful inventory Evidence record into an inspection report. */
export const createArtifactInspection = (
  inventoryInput: unknown,
  limits: ArtifactInspectionLimits,
): ArtifactInspectionResult => {
  const inventoryEvidence = parseInventoryEvidence(inventoryInput);
  const inventory = artifactInventoryResultSchema.parse(
    inventoryEvidence.normalized_result,
  );
  const observations = allObservations(
    inventory,
    inventoryEvidence.evidence_id,
  );
  const relationships = allRelationships(
    inventory,
    inventoryEvidence.evidence_id,
  );
  const hypotheses = allHypotheses(inventory, inventoryEvidence.evidence_id);
  const nextProbes = probesFor(inventory);
  const branches = allUnexploredBranches(
    inventory,
    inventoryEvidence.evidence_id,
    nextProbes,
  );
  const retained = {
    observations: observations.slice(0, limits.max_observations),
    relationships: relationships.slice(0, limits.max_relationships),
    hypotheses: hypotheses.slice(0, limits.max_hypotheses),
    branches: branches.slice(0, limits.max_unexplored_branches),
    probes: nextProbes.slice(0, limits.max_next_probes),
  };
  const omissions = {
    observations: observations.length - retained.observations.length,
    relationships: relationships.length - retained.relationships.length,
    hypotheses: hypotheses.length - retained.hypotheses.length,
    branches: branches.length - retained.branches.length,
    probes: nextProbes.length - retained.probes.length,
  };
  const semantic = {
    schema_version: 1 as const,
    subject: {
      manifest_id: inventory.manifest.manifest_id,
      root_artifact_id: inventory.manifest.root_artifact_id,
      root_sha256: inventory.manifest.root_sha256,
      root_format: inventory.manifest.root_format,
    },
    substeps: [
      {
        substep_id: `ais_${digestCanonical({
          operation: "inventory_artifact",
          evidence_id: inventoryEvidence.evidence_id,
        })}`,
        operation: "inventory_artifact" as const,
        status: "completed" as const,
        evidence_id: inventoryEvidence.evidence_id,
        evidence: inventoryEvidence,
      },
    ],
    observations: retained.observations,
    derived_relationships: retained.relationships,
    hypotheses: retained.hypotheses,
    contradictions: contradictions(inventory, inventoryEvidence.evidence_id),
    unexplored_branches: retained.branches,
    next_probes: retained.probes,
    coverage: {
      status: inspectionCoverage(inventory, omissions),
      substeps_completed: 1 as const,
      observations_retained: retained.observations.length,
      observations_omitted: omissions.observations,
      relationships_retained: retained.relationships.length,
      relationships_omitted: omissions.relationships,
      hypotheses_retained: retained.hypotheses.length,
      hypotheses_omitted: omissions.hypotheses,
      unexplored_branches_retained: retained.branches.length,
      unexplored_branches_omitted: omissions.branches,
      next_probes_retained: retained.probes.length,
      next_probes_omitted: omissions.probes,
    },
    evidence_links: [inventoryEvidence.evidence_id],
    limitations: uniqueSorted([
      ...inventory.limitations,
      "Inspection derives bounded static hypotheses and next probes; it does not execute the artifact or claim format-specific semantics.",
    ]),
  };
  return artifactInspectionResultSchema.parse({
    ...semantic,
    inspection_id: `ai_${digestCanonical(semantic)}`,
  });
};

const parseInventoryEvidence = (input: unknown): Evidence => {
  const evidence = parseEvidence(input);
  if (evidence.operation !== "inventory_artifact")
    throw new TypeError(
      "Artifact inspection substep requires inventory_artifact Evidence",
    );
  return evidence;
};

const allObservations = (
  inventory: ArtifactInventoryResult,
  evidenceId: string,
): ArtifactInspectionResult["observations"] => [
  observation(
    "root-manifest",
    inventory.manifest.root_artifact_id,
    inventory.manifest,
    evidenceId,
  ),
  ...inventory.nodes.items.map((node) =>
    observation("artifact", node.artifact_id, node, evidenceId),
  ),
  ...inventory.occurrences.items.map((occurrence) =>
    observation("occurrence", occurrence.occurrence_id, occurrence, evidenceId),
  ),
  ...inventory.integrity_contradictions.map((value) =>
    observation("integrity", value.contradiction_id, value, evidenceId),
  ),
];

const observation = (
  kind: ArtifactInspectionResult["observations"][number]["kind"],
  subject: string,
  value: unknown,
  evidenceId: string,
): ArtifactInspectionResult["observations"][number] => {
  const semantic = {
    kind,
    subject,
    value: jsonValueSchema.parse(value),
    evidence_id: evidenceId,
  };
  return { observation_id: `aio_${digestCanonical(semantic)}`, ...semantic };
};

const allRelationships = (
  inventory: ArtifactInventoryResult,
  evidenceId: string,
): ArtifactInspectionResult["derived_relationships"] =>
  inventory.edges.items.map((edge) => {
    const semantic = {
      relation: edge.relation,
      source_artifact_id: edge.parent_artifact_id,
      target_artifact_id: edge.child_artifact_id,
      occurrence_id: edge.occurrence_id,
      logical_path: edge.logical_path,
      evidence_id: evidenceId,
    };
    return {
      relationship_id: `air_${digestCanonical(semantic)}`,
      ...semantic,
    };
  });

const allHypotheses = (
  inventory: ArtifactInventoryResult,
  evidenceId: string,
): ArtifactInspectionResult["hypotheses"] => {
  const statements =
    inventory.manifest.root_format === "pe"
      ? [
          "The PE artifact may contain managed CLI metadata or native code; inventory bytes alone do not distinguish them.",
        ]
      : ["asar", "javascript-bundle"].includes(inventory.manifest.root_format)
        ? [
            "The artifact may contain a recoverable JavaScript application graph.",
          ]
        : [];
  return statements.map((statement) => {
    const semantic = {
      statement,
      confidence: "low" as const,
      basis_evidence_ids: [evidenceId],
      limitation:
        "Format classification proposes a bounded follow-up; it is not semantic proof.",
    };
    return { hypothesis_id: `aih_${digestCanonical(semantic)}`, ...semantic };
  });
};

const contradictions = (
  inventory: ArtifactInventoryResult,
  evidenceId: string,
): ArtifactInspectionResult["contradictions"] =>
  inventory.integrity_contradictions.map((value) => {
    const semantic = {
      statement: `Declared integrity for ${value.logical_path} contradicts observed bytes.`,
      occurrence_id: value.occurrence_id,
      declared_sha256: value.declared_sha256,
      observed_sha256: value.observed_sha256,
      evidence_id: evidenceId,
    };
    return {
      contradiction_id: `aic_${digestCanonical(semantic)}`,
      ...semantic,
    };
  });

const probesFor = (
  inventory: ArtifactInventoryResult,
): ArtifactInspectionResult["next_probes"] => {
  const format = inventory.manifest.root_format;
  if (["asar", "javascript-bundle", "directory"].includes(format))
    return [
      {
        operation: "analyze_javascript_application",
        rationale:
          "Recover bounded JavaScript modules, source maps, Electron boundaries, and application relationships.",
        authority: "ast-static-analysis",
      },
    ];
  if (format === "pe")
    return [
      {
        operation: "inspect_managed_artifact",
        rationale:
          "Check execution-free CLI metadata before choosing a deep native provider.",
        authority: "managed-static-analysis",
      },
      {
        operation: "open_binary",
        rationale:
          "Open as native code only when managed inspection reports a native or mixed boundary.",
        authority: "native-analysis-provider",
      },
    ];
  if (["mach-o", "mach-o-universal", "elf"].includes(format))
    return [
      {
        operation: "open_binary",
        rationale:
          "Bind one deep native provider before function-level analysis.",
        authority: "native-analysis-provider",
      },
    ];
  if (format === "plist")
    return [
      {
        operation: "inspect_plist",
        rationale: "Parse property-list values without executing the artifact.",
        authority: "artifact-bytes",
      },
    ];
  return [];
};

const allUnexploredBranches = (
  inventory: ArtifactInventoryResult,
  evidenceId: string,
  nextProbes: ArtifactInspectionResult["next_probes"],
): ArtifactInspectionResult["unexplored_branches"] => {
  const pages = [
    ["nodes", inventory.nodes.next_offset],
    ["occurrences", inventory.occurrences.next_offset],
    ["relationships", inventory.edges.next_offset],
  ] as const;
  const branches = pages.flatMap(([collection, nextOffset]) =>
    nextOffset === null
      ? []
      : [
          branch(
            "page-limit",
            `${collection} continue at offset ${String(nextOffset)}.`,
            null,
            evidenceId,
          ),
        ],
  );
  branches.push(
    ...nextProbes.map((probe) =>
      branch(
        "format-specific-analysis-required",
        `${probe.operation} was not run by provider-neutral artifact inspection.`,
        probe,
        evidenceId,
      ),
    ),
  );
  if (inventory.manifest.root_format === "unknown")
    branches.push(
      branch(
        "unknown-format",
        "Artifact bytes did not match an admitted format classifier.",
        null,
        evidenceId,
      ),
    );
  return branches;
};

const branch = (
  reason: ArtifactInspectionResult["unexplored_branches"][number]["reason"],
  detail: string,
  nextProbe: ArtifactInspectionResult["next_probes"][number] | null,
  evidenceId: string,
): ArtifactInspectionResult["unexplored_branches"][number] => {
  const semantic = {
    reason,
    detail,
    next_probe: nextProbe,
    evidence_id: evidenceId,
  };
  return { branch_id: `aib_${digestCanonical(semantic)}`, ...semantic };
};

const inspectionCoverage = (
  inventory: ArtifactInventoryResult,
  omissions: Readonly<Record<string, number>>,
): ArtifactInspectionResult["coverage"]["status"] => {
  if (Object.values(omissions).some((count) => count > 0)) return "truncated";
  return [
    inventory.nodes.next_offset,
    inventory.occurrences.next_offset,
    inventory.edges.next_offset,
  ].some((offset) => offset !== null)
    ? "partial"
    : "complete-within-substeps";
};

const digestCanonical = (value: unknown): string => {
  const encoded = canonicalize(value);
  if (encoded === undefined)
    throw new TypeError("Artifact inspection could not canonicalize");
  return createHash("sha256").update(encoded).digest("hex");
};

const uniqueSorted = (values: readonly string[]): string[] =>
  [...new Set(values)].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
