import { z } from "zod";

/** Resource safeguards for local artifact traversal and static parsing. */
export const JAVASCRIPT_APPLICATION_RESOURCE_LIMITS = {
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
