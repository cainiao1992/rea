import type { EvidenceFilePolicy } from "../domain/evidenceBundle.js";
import type { ProcessExecutionPolicy } from "../domain/processCapture.js";

export interface SessionAvailability {
  readonly processCaptureEnabled: boolean;
  readonly evidenceFileRoots: number;
  readonly investigationInputRoots: number;
  readonly browserObservationEnabled?: boolean;
  readonly browserScenarioEnabled?: boolean;
  readonly electronObservationEnabled?: boolean;
  readonly v8InspectorObservationEnabled?: boolean;
  readonly javascriptReplayEnabled?: boolean;
  readonly managedRuntimeEnabled?: boolean;
}

export interface SessionAvailabilityDefaults {
  readonly processPolicy: ProcessExecutionPolicy;
  readonly evidenceFilePolicy: EvidenceFilePolicy;
  readonly investigationInputRoots: readonly string[];
  readonly optionalFeatures?: Pick<
    SessionAvailability,
    | "browserObservationEnabled"
    | "browserScenarioEnabled"
    | "electronObservationEnabled"
    | "v8InspectorObservationEnabled"
    | "javascriptReplayEnabled"
    | "managedRuntimeEnabled"
  >;
}

/** Select configured availability reporting or the target-free defaults. */
export const sessionAvailabilityPolicy = (
  configured: (() => SessionAvailability) | undefined,
  defaults: SessionAvailabilityDefaults,
): (() => SessionAvailability) =>
  configured ??
  (() => ({
    processCaptureEnabled: defaults.processPolicy.enabled,
    evidenceFileRoots: defaults.evidenceFilePolicy.roots.length,
    investigationInputRoots: defaults.investigationInputRoots.length,
    browserObservationEnabled:
      defaults.optionalFeatures?.browserObservationEnabled ?? false,
    browserScenarioEnabled:
      defaults.optionalFeatures?.browserScenarioEnabled ?? false,
    electronObservationEnabled:
      defaults.optionalFeatures?.electronObservationEnabled ?? false,
    v8InspectorObservationEnabled:
      defaults.optionalFeatures?.v8InspectorObservationEnabled ?? false,
    javascriptReplayEnabled:
      defaults.optionalFeatures?.javascriptReplayEnabled ?? false,
    managedRuntimeEnabled:
      defaults.optionalFeatures?.managedRuntimeEnabled ?? false,
  }));
