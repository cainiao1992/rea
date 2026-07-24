import { z } from "zod";

import {
  AnalysisInputError,
  AnalysisProtocolError,
  type AnalysisError,
} from "../domain/errors.js";
import { createEvidence, type Evidence } from "../domain/evidence.js";
import { jsonObjectSchema, jsonValueSchema } from "../domain/jsonValue.js";
import { createReconstructionReadinessReport } from "../domain/reconstructionReadiness.js";
import {
  reconstructionReadinessInputSchema,
  type ReconstructionReadinessInput,
} from "../domain/reconstructionReadinessSchemas.js";
import { err, ok, type Result } from "../domain/result.js";
import { JAVASCRIPT_APPLICATION_WORKFLOW_PROVIDER } from "./InvestigationProviders.js";

const OPERATION = "evaluate_reconstruction_readiness" as const;

/** Parse one portable readiness request for both CLI and MCP adapters. */
export const resolveReconstructionReadinessRequest = (
  input: unknown,
): Result<ReconstructionReadinessInput, AnalysisError> => {
  const parsed = reconstructionReadinessInputSchema.safeParse(input);
  return parsed.success
    ? ok(parsed.data)
    : err(new AnalysisInputError(OPERATION, { cause: parsed.error }));
};

/** Evaluate and wrap one deterministic readiness report in Evidence v2. */
export const evaluateReconstructionReadinessValidated = (
  input: ReconstructionReadinessInput,
): Result<Evidence, AnalysisError> => {
  try {
    const report = createReconstructionReadinessReport(input);
    return ok(
      createEvidence(undefined, JAVASCRIPT_APPLICATION_WORKFLOW_PROVIDER, {
        predicateType: "rea.reconstruction-readiness-report/v1",
        operation: OPERATION,
        parameters: jsonObjectSchema.parse({
          source_digest: report.source_digest,
          expected_source_digest: input.replay.expected_source_digest,
        }),
        result: jsonValueSchema.parse(report),
        rawResult: null,
        confidence: "inferred",
        authority: "analyst-inference",
        environment: null,
        limitations:
          report.status === "pass"
            ? []
            : [
                "Aggregate pass is withheld until every required conformance stage passes.",
              ],
        evidenceLinks: report.evidence_links,
      }),
    );
  } catch (cause: unknown) {
    if (cause instanceof z.ZodError)
      return err(new AnalysisInputError(OPERATION, { cause }));
    return err(
      new AnalysisProtocolError("Reconstruction readiness evaluation failed", {
        cause,
      }),
    );
  }
};
