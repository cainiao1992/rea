import { z } from "zod";

import type { ArtifactLimits } from "../artifacts/ArtifactReader.js";

/** Resource safeguards for local artifact traversal and static parsing. */
export const JAVASCRIPT_APPLICATION_RESOURCE_LIMITS = {
  artifact: {
    maxEntries: 8_000,
    maxTotalBytes: 512 * 1_024 * 1_024,
    maxEntryBytes: 128 * 1_024 * 1_024,
    maxCompressionRatio: 1_000,
    maxDepth: 64,
    maxPathBytes: 4_096,
  } satisfies ArtifactLimits,
  maxTextFiles: 5_000,
  maxTotalTextBytes: 128 * 1_024 * 1_024,
  maxTextFileBytes: 8 * 1_024 * 1_024,
  maxAstNodes: 2_000_000,
  maxParseMilliseconds: 30_000,
} as const;

/** Local ASAR/directory reconstruction request. */
export const javascriptArtifactReconstructionInputSchema = z.strictObject({
  input_path: z.string().min(1),
  format: z.enum(["auto", "asar", "directory"]).default("auto"),
});

/** Parsed local reconstruction request. */
export type JavaScriptArtifactReconstructionInput = z.infer<
  typeof javascriptArtifactReconstructionInputSchema
>;

/** Project private resource safeguards into the artifact traversal policy. */
export const artifactLimitsForReconstruction = (): ArtifactLimits =>
  JAVASCRIPT_APPLICATION_RESOURCE_LIMITS.artifact;
