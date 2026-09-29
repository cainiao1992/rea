import type { ProcessExecutionPolicy } from "../domain/processCapture.js";

/** Fail-closed process policy used when operator configuration is absent. */
export const DENY_PROCESS_POLICY: ProcessExecutionPolicy = {
  status: "disabled",
};

export { PROCESS_PROVIDER } from "../application/ProcessEvidence.js";
export {
  ARTIFACT_COMPARISON_PROVIDER,
  BUNDLE_COMPARISON_PROVIDER,
  CALL_PATH_PROVIDER,
  CHANGED_BEHAVIOR_PROVIDER,
  FUNCTION_COMPARISON_PROVIDER,
  RECONSTRUCTION_PROVIDER,
  STATIC_RUNTIME_PROVIDER,
} from "../application/InvestigationProviders.js";
