import { z } from "zod";

import type { ToolContract } from "./toolContracts.js";
import { managedOutputSchemas } from "./toolOutputSchemas.js";
import { toolContractMetadata } from "./toolEffects.js";
import { requireOutputSchema } from "./toolOutputSchemaPrimitives.js";

/** Exact caller boundary for execution-free PE/CLI triage and identity. */
export const managedArtifactInputSchema = z.object({
  path: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Managed PE/CLI path to open before inspection; omit only when a managed target is already active",
    ),
});

/** Exact caller boundary for execution-free metadata/signature/IL inspection. */
export const managedMemberInputSchema = z.object({});

/** Exact caller boundary for execution-free managed/native boundary inspection. */
export const managedNativeBoundaryInputSchema = z.object({});

const outputSchema = requireOutputSchema(
  managedOutputSchemas,
  "inspect_managed_artifact",
);
const memberOutputSchema = requireOutputSchema(
  managedOutputSchemas,
  "inspect_managed_members",
);
const nativeBoundaryOutputSchema = requireOutputSchema(
  managedOutputSchemas,
  "inspect_managed_native_boundaries",
);

/** Read-only managed artifact contracts. */
export const MANAGED_TOOL_CONTRACTS = [
  {
    name: "inspect_managed_artifact",
    ...toolContractMetadata("inspect_managed_artifact"),
    description:
      "Open and classify an explicit managed PE/CLI path, or inspect the active managed target, then inventory exact assembly/module identity, target framework evidence, references, resources, and custom attributes without loading or executing target code. Returns complete inline inventories when metadata is admitted and explicit partial or malformed coverage otherwise.",
    kind: "managed-provider",
    inputSchema: managedArtifactInputSchema,
    outputSchema,
    examples: [
      {
        title: "Example inspect managed artifact request",
        input: { path: "/tmp/Example.dll" },
      },
    ],
  },
  {
    name: "inspect_managed_members",
    ...toolContractMetadata("inspect_managed_members"),
    description:
      "Inspect PE/CLI metadata members, signatures, raw CIL hashes, member-result-v1 decoded-instruction-tuple hashes, separately reported exception regions, call edges, and field-access anchors without loading or executing target code. Metadata tokens are reported as build-local coordinates bound to the artifact SHA-256 and MVID; the v1 tuple hash does not resolve them or fully commit control flow.",
    kind: "managed-provider",
    inputSchema: managedMemberInputSchema,
    outputSchema: memberOutputSchema,
    examples: [
      {
        title: "Example inspect managed members request",
        input: {},
      },
    ],
  },
  {
    name: "inspect_managed_native_boundaries",
    ...toolContractMetadata("inspect_managed_native_boundaries"),
    description:
      "Inspect PE/CLI ModuleRef, ImplMap/PInvoke declarations, CLI native-header indicators, and non-IL method implementation flags without loading or executing target code. Results are managed declarations and degraded native-boundary observations, not verified native exports or addresses.",
    kind: "managed-provider",
    inputSchema: managedNativeBoundaryInputSchema,
    outputSchema: nativeBoundaryOutputSchema,
    examples: [
      {
        title: "Example inspect managed/native boundary request",
        input: {},
      },
    ],
  },
] as const satisfies readonly ToolContract[];

/** Names of execution-free managed static operations. */
export type ManagedToolName = (typeof MANAGED_TOOL_CONTRACTS)[number]["name"];
