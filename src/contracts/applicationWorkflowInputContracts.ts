import { z } from "zod";

import { evidenceSchema } from "../domain/evidence.js";
import { compareApplicationVersionsInputSchema } from "../domain/javascriptApplicationVersionComparisonSchemas.js";
import { compareJavaScriptExportShapesInputSchema } from "../domain/javascriptExportShapeComparisonSchemas.js";
import { traceApplicationFeatureInputSchema } from "../domain/javascriptFeatureTraceSchemas.js";
import { javaScriptSemanticQueryInputSchema } from "../domain/javascriptSemanticQuerySchemas.js";
import { compareSourceToBundleInputSchema } from "../domain/sourceToBundleComparisonSchemas.js";

const evidenceIdSchema = z
  .string()
  .regex(/^ev_[a-f0-9]{64}$/u)
  .describe("Evidence ID returned earlier in this session");

const traceApplicationFeatureFacts = {
  native_observations:
    traceApplicationFeatureInputSchema.shape.native_observations,
  native_observation_evidence_ids: z.array(evidenceIdSchema).default([]),
  seed: traceApplicationFeatureInputSchema.shape.seed,
  direction: traceApplicationFeatureInputSchema.shape.direction,
} as const;

/** MCP/CLI trace request accepting full Evidence or a ledger reference. */
export const traceApplicationFeatureRequestSchema = z.union([
  z.strictObject({
    ...traceApplicationFeatureFacts,
    application: evidenceSchema,
  }),
  z.strictObject({
    ...traceApplicationFeatureFacts,
    application_evidence_id: evidenceIdSchema,
  }),
]);

/** MCP/CLI semantic trace request accepting full Evidence or a ledger reference. */
export const traceJavaScriptSemanticsRequestSchema = z.union([
  z.strictObject({
    application: evidenceSchema,
    query: javaScriptSemanticQueryInputSchema,
  }),
  z.strictObject({
    application_evidence_id: evidenceIdSchema,
    query: javaScriptSemanticQueryInputSchema,
  }),
]);

const compareApplicationVersionsFacts = {
  left_native_observations:
    compareApplicationVersionsInputSchema.shape.left_native_observations,
  left_native_observation_evidence_ids: z.array(evidenceIdSchema).default([]),
  right_native_observations:
    compareApplicationVersionsInputSchema.shape.right_native_observations,
  right_native_observation_evidence_ids: z.array(evidenceIdSchema).default([]),
} as const;

const applicationEvidenceReferenceSchema = z.union([
  evidenceSchema,
  evidenceIdSchema,
]);

/** MCP/CLI comparison request accepting inline Evidence or session Evidence IDs. */
export const compareApplicationVersionsRequestSchema = z
  .strictObject({
    ...compareApplicationVersionsFacts,
    left: applicationEvidenceReferenceSchema
      .optional()
      .describe(
        "Full application Evidence or an Evidence ID returned this session",
      ),
    right: applicationEvidenceReferenceSchema
      .optional()
      .describe(
        "Full application Evidence or an Evidence ID returned this session",
      ),
    // Retain the original ID property names for existing callers.
    left_evidence_id: evidenceIdSchema.optional(),
    right_evidence_id: evidenceIdSchema.optional(),
  })
  .superRefine((input, context) => {
    for (const side of ["left", "right"] as const) {
      const alias = `${side}_evidence_id` as const;
      const hasValue = input[side] !== undefined;
      const hasAlias = input[alias] !== undefined;
      if (hasValue === hasAlias) {
        context.addIssue({
          code: "custom",
          path: [side],
          message: `Provide exactly one of ${side} or ${alias}`,
        });
      }
    }
  });

const compareSourceToBundleFacts = {
  reference: compareSourceToBundleInputSchema.shape.reference,
} as const;

/** Historical-source comparison accepting full application Evidence or a ledger reference. */
export const compareSourceToBundleRequestSchema = z.union([
  z.strictObject({
    ...compareSourceToBundleFacts,
    application: evidenceSchema,
  }),
  z.strictObject({
    ...compareSourceToBundleFacts,
    application_evidence_id: evidenceIdSchema,
  }),
]);

const compareJavaScriptExportShapesFacts = {
  left_module_path:
    compareJavaScriptExportShapesInputSchema.shape.left_module_path,
  left_export_name:
    compareJavaScriptExportShapesInputSchema.shape.left_export_name,
  right_module_path:
    compareJavaScriptExportShapesInputSchema.shape.right_module_path,
  right_export_name:
    compareJavaScriptExportShapesInputSchema.shape.right_export_name,
} as const;

/** MCP/CLI export-shape request accepting full Evidence or ledger references. */
export const compareJavaScriptExportShapesRequestSchema = z.union([
  z.strictObject({
    ...compareJavaScriptExportShapesFacts,
    left: evidenceSchema,
    right: evidenceSchema,
  }),
  z.strictObject({
    ...compareJavaScriptExportShapesFacts,
    left: evidenceSchema,
    right_evidence_id: evidenceIdSchema,
  }),
  z.strictObject({
    ...compareJavaScriptExportShapesFacts,
    left_evidence_id: evidenceIdSchema,
    right: evidenceSchema,
  }),
  z.strictObject({
    ...compareJavaScriptExportShapesFacts,
    left_evidence_id: evidenceIdSchema,
    right_evidence_id: evidenceIdSchema,
  }),
]);

export type TraceApplicationFeatureRequest = z.output<
  typeof traceApplicationFeatureRequestSchema
>;
export type TraceJavaScriptSemanticsRequest = z.output<
  typeof traceJavaScriptSemanticsRequestSchema
>;
export type CompareApplicationVersionsRequest = z.output<
  typeof compareApplicationVersionsRequestSchema
>;
export type CompareSourceToBundleRequest = z.output<
  typeof compareSourceToBundleRequestSchema
>;
export type CompareJavaScriptExportShapesRequest = z.output<
  typeof compareJavaScriptExportShapesRequestSchema
>;
