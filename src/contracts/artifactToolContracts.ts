import { z } from "zod";

import type { ToolContract } from "./toolContracts.js";
import { artifactOutputSchemas } from "./toolOutputSchemas.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import { toolContractMetadata } from "./toolEffects.js";
import { requireOutputSchema } from "./toolOutputSchemaPrimitives.js";
const integrityInput = {
  fail: {
    integrity_policy: z.literal("fail").default("fail"),
    integrity_continue_approved: z.literal(false).default(false),
  },
  continue: {
    integrity_policy: z.literal("record-and-continue"),
    integrity_continue_approved: z.literal(true),
  },
} as const;

const artifactInventoryFacts = {
  native_mount_approved: z.boolean().default(false),
} as const;

/** Exact caller boundary for deterministic artifact inventory. */
export const artifactInventoryInputSchema = z.union([
  z.object({ ...artifactInventoryFacts, ...integrityInput.fail }),
  z.object({ ...artifactInventoryFacts, ...integrityInput.continue }),
]);

/** Exact caller boundary for approved artifact extraction. */
export const artifactExtractionInputSchema = z.object({
  occurrence_ids: z.array(z.string().regex(/^occ_[a-f0-9]{64}$/u)).min(1),
});

/** Provider input after the local permission boundary chooses its destination. */
export const artifactExtractionExecutionSchema =
  artifactExtractionInputSchema.extend({ output_root: z.string().min(1) });

/** Bounded provider-neutral inspection using one atomic inventory substep. */
const artifactInspectionFacts = {
  native_mount_approved: z.boolean().default(false),
} as const;
export const artifactInspectionInputSchema = z.union([
  z.object({ ...artifactInspectionFacts, ...integrityInput.fail }),
  z.object({ ...artifactInspectionFacts, ...integrityInput.continue }),
]);

const exampleInputSchema = z.record(z.string(), jsonValueSchema);
const examples: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  inventory_artifact: {},
  inspect_artifact: {},
  extract_artifact: {
    occurrence_ids: [`occ_${"0".repeat(64)}`],
  },
};

const artifact = <
  Name extends string,
  Schema extends z.ZodType<Readonly<Record<string, unknown>>>,
>(
  name: Name,
  description: string,
  inputSchema: Schema,
) => {
  const outputSchema = requireOutputSchema(artifactOutputSchemas, name);
  return {
    name,
    ...toolContractMetadata(name),
    description,
    kind: "artifact-provider",
    inputSchema,
    outputSchema,
    examples: [
      {
        title: `Example ${name.replaceAll("_", " ")} request`,
        input: exampleInputSchema.parse(examples[name] ?? {}),
      },
    ],
  } satisfies ToolContract<Name, Schema, typeof outputSchema>;
};

/** Artifact-graph inventory and safe extraction contracts. */
export const ARTIFACT_TOOL_CONTRACTS = [
  artifact(
    "inventory_artifact",
    "After open_binary binds a local archive, application package, or other artifact—or when one is already active—inventory the complete content-addressed artifact graph in one call. This tool accepts no path; in a target-free session open the target first. It does not extract or mount by default.",
    artifactInventoryInputSchema,
  ),
  artifact(
    "inspect_artifact",
    "After open_binary binds a local archive, application package, or other artifact—or when one is already active—inspect the complete artifact inventory in one cancellable substep. This tool accepts no path; in a target-free session open the target first. Returns the full substep Evidence, observations, derived relationships, hypotheses, contradictions, unexplored branches, limitations, and format-specific next probes. Any substep failure fails the whole call.",
    artifactInspectionInputSchema,
  ),
  artifact(
    "extract_artifact",
    "Extract selected graph artifacts into a fresh temporary directory chosen by REA. The result includes its location. Rejects traversal and symlink escapes, never overwrites, enforces archive integrity checks, and verifies cleanup.",
    artifactExtractionInputSchema,
  ),
] as const satisfies readonly ToolContract[];

/** Names of provider-neutral artifact graph operations. */
export type ArtifactToolName = (typeof ARTIFACT_TOOL_CONTRACTS)[number]["name"];
