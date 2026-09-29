import type { ProviderIdentity } from "./AnalysisProvider.js";
import {
  createEvidence,
  type Evidence,
  type EvidenceObservation,
} from "../domain/evidence.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import type {
  JavaScriptRuntimeObservation,
  JavaScriptRuntimeTargetList,
  ListJavaScriptRuntimeTargetsInput,
  ObserveJavaScriptRuntimeInput,
} from "../domain/javascriptRuntimeObservation.js";

type RuntimeObservationOperation =
  | "list_javascript_runtime_targets"
  | "observe_javascript_runtime";

/** Create deterministic Evidence for one passive Inspector operation. */
export const createJavaScriptRuntimeObservationEvidence = (
  operation: RuntimeObservationOperation,
  input: ListJavaScriptRuntimeTargetsInput | ObserveJavaScriptRuntimeInput,
  result: JavaScriptRuntimeTargetList | JavaScriptRuntimeObservation,
  provider: ProviderIdentity,
): Evidence =>
  createEvidence(undefined, provider, {
    predicateType:
      operation === "list_javascript_runtime_targets"
        ? "rea.javascript-runtime-target-list"
        : "rea.javascript-runtime-observation",
    operation,
    parameters: parameters(input),
    result: jsonValueSchema.parse(result),
    rawResult: null,
    confidence: "observed",
    authority: "external-service",
    environment: {
      id: `${result.runtime.product}@${result.runtime.protocol_version}`,
      platform: process.platform,
      architecture: process.arch,
      isolation: "none",
    },
    limitations: result.limitations,
  });

const parameters = (
  input: ListJavaScriptRuntimeTargetsInput | ObserveJavaScriptRuntimeInput,
): EvidenceObservation["parameters"] => ({
  inspector_endpoint: input.inspector_endpoint,
  ...("target_id" in input
    ? {
        target_id: input.target_id,
        ...(input.runtime_kind === undefined
          ? {}
          : { runtime_kind: input.runtime_kind }),
        observation_ms: input.observation_ms,
      }
    : {}),
});
