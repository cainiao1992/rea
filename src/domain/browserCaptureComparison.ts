import { z } from "zod";

import {
  browserScenarioDiffSchema,
  compareBrowserScenarios,
  compareBrowserScenariosInputSchema,
  type BrowserScenarioDiff,
  type CompareBrowserScenariosInput,
} from "./browserScenarioDiff.js";
import {
  compareWebCaptures,
  captureSnapshotSchema,
  webCaptureDiffSchema,
  type CompareWebCapturesInput,
  type WebCaptureDiff,
} from "./webCaptureDiff.js";

/** Top-level MCP shape for legacy page or step-indexed scenario comparison. */
export const browserCaptureComparisonWireSchema = z
  .strictObject({
    before: captureSnapshotSchema
      .optional()
      .describe("Earlier passive web-page capture; pair with after."),
    after: captureSnapshotSchema
      .optional()
      .describe("Later passive web-page capture; pair with before."),
    before_scenario: compareBrowserScenariosInputSchema.shape.before_scenario
      .optional()
      .describe("Earlier browser scenario capture; pair with after_scenario."),
    after_scenario: compareBrowserScenariosInputSchema.shape.after_scenario
      .optional()
      .describe("Later browser scenario capture; pair with before_scenario."),
    normalization:
      compareBrowserScenariosInputSchema.shape.normalization.describe(
        "Scenario-only exact-literal normalization policy.",
      ),
    max_changes: z
      .number()
      .int()
      .min(1)
      .max(20_000)
      .default(2_000)
      .describe("Maximum normalized change records to retain."),
  })
  .superRefine((input, context) => {
    const hasPassive = input.before !== undefined || input.after !== undefined;
    const hasScenario =
      input.before_scenario !== undefined || input.after_scenario !== undefined;
    if (hasPassive === hasScenario)
      context.addIssue({
        code: "custom",
        message:
          "Provide exactly one complete pair: before/after or before_scenario/after_scenario",
      });
    if (hasPassive && (input.before === undefined || input.after === undefined))
      context.addIssue({
        code: "custom",
        message: "Passive comparison requires both before and after",
      });
    if (
      hasScenario &&
      (input.before_scenario === undefined ||
        input.after_scenario === undefined)
    )
      context.addIssue({
        code: "custom",
        message:
          "Browser scenario comparison requires both before_scenario and after_scenario",
      });
    if (hasPassive && input.normalization.rules.length > 0)
      context.addIssue({
        code: "custom",
        path: ["normalization"],
        message:
          "Literal normalization rules apply only to browser scenario captures",
      });
  });

/** Parsed legacy page snapshots or step-indexed browser scenarios. */
export const browserCaptureComparisonInputSchema =
  browserCaptureComparisonWireSchema.transform((input) => {
    if (
      input.before_scenario !== undefined &&
      input.after_scenario !== undefined
    )
      return {
        before_scenario: input.before_scenario,
        after_scenario: input.after_scenario,
        normalization: input.normalization,
        max_changes: input.max_changes,
      } satisfies CompareBrowserScenariosInput;
    if (input.before !== undefined && input.after !== undefined)
      return {
        before: input.before,
        after: input.after,
        max_changes: input.max_changes,
      } satisfies CompareWebCapturesInput;
    throw new TypeError("Capture comparison pair refinement failed");
  });
/** Parsed browser capture comparison input. */
export type BrowserCaptureComparisonInput = z.output<
  typeof browserCaptureComparisonInputSchema
>;

/** Result from passive page or browser scenario comparison. */
export const browserCaptureComparisonSchema = z.union([
  browserScenarioDiffSchema,
  webCaptureDiffSchema,
]);
/** Browser capture comparison result. */
export type BrowserCaptureComparison = BrowserScenarioDiff | WebCaptureDiff;

/** Dispatch a parsed capture comparison to its pure domain comparator. */
export const compareBrowserCaptures = (
  input: BrowserCaptureComparisonInput,
): BrowserCaptureComparison =>
  isScenarioComparison(input)
    ? compareBrowserScenarios(input)
    : compareWebCaptures(input);

const isScenarioComparison = (
  input: BrowserCaptureComparisonInput,
): input is CompareBrowserScenariosInput => "before_scenario" in input;
