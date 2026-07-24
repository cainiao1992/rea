import type { Evidence } from "../domain/evidence.js";
import type { ReconstructionObligation } from "../domain/reconstructionObligationLedgerSchemas.js";

type ProofAuthority = ReconstructionObligation["required_fixture_authority"];
type OriginalAuthority =
  ReconstructionObligation["required_original_authority"];
type ProofEvidenceShape = readonly [predicate: string, operation: string];

const proofEvidenceShapes: Readonly<
  Record<ProofAuthority, readonly ProofEvidenceShape[]>
> = {
  unit: [["rea.fixture-verification/v1", "run_fixture_verifier"]],
  integration: [["rea.fixture-verification/v1", "run_fixture_verifier"]],
  protocol: [["rea.protocol-observation/v1", "observe_protocol"]],
  renderer: [
    ["rea.browser-scenario-capture/v1", "capture_browser_scenario"],
    ["rea.electron-page-inspection/v1", "inspect_electron_page"],
  ],
  "packaged-process": [
    ["rea.process-capture/v4", "capture_process_scenario"],
    [
      "rea.reconstruction-readiness-fixture/v1",
      "run_reconstruction_readiness_fixture",
    ],
  ],
  "native-abi": [
    ["rea.managed-native-verification/v1", "verify_managed_native_boundaries"],
  ],
  "live-observation": [
    ["javascript-controlled-replay-observation", "run_controlled_replay"],
    ["rea.browser-scenario-capture/v1", "capture_browser_scenario"],
    ["rea.electron-page-inspection/v1", "inspect_electron_page"],
    ["rea.javascript-runtime-observation/v1", "observe_javascript_runtime"],
    ["rea.runtime-characterization/v1", "execute_node_characterization"],
  ],
  external: [["rea.protocol-observation/v1", "observe_protocol"]],
};

const proofEvidenceAuthorities: Readonly<
  Record<ProofAuthority, readonly Evidence["authority"][]>
> = {
  unit: ["shipped-artifact", "controlled-replay"],
  integration: ["controlled-replay"],
  protocol: ["controlled-replay", "external-service"],
  renderer: ["controlled-replay", "external-service"],
  "packaged-process": ["controlled-replay"],
  "native-abi": ["shipped-artifact", "controlled-replay"],
  "live-observation": ["controlled-replay", "external-service"],
  external: ["external-service"],
};

/** Return whether an actual reconstruction proof is comparable to a requirement. */
export const proofAuthoritySatisfies = (
  actual: ProofAuthority,
  required: ProofAuthority,
): boolean => {
  const accepted: Readonly<Record<ProofAuthority, readonly ProofAuthority[]>> =
    {
      unit: [
        "unit",
        "integration",
        "protocol",
        "renderer",
        "packaged-process",
        "native-abi",
        "live-observation",
        "external",
      ],
      integration: [
        "integration",
        "protocol",
        "renderer",
        "packaged-process",
        "native-abi",
        "live-observation",
      ],
      protocol: ["protocol", "packaged-process", "live-observation"],
      renderer: ["renderer", "packaged-process", "live-observation"],
      "packaged-process": ["packaged-process", "live-observation"],
      "native-abi": ["native-abi"],
      "live-observation": ["live-observation"],
      external: ["external"],
    };
  return accepted[required].includes(actual);
};

/** Check that Evidence can authenticate the declared reconstruction authority. */
export const evidenceAuthoritySupportsProof = (
  evidence: Evidence,
  authority: ProofAuthority,
): boolean =>
  evidence.confidence === "observed" &&
  proofEvidenceAuthorities[authority].includes(evidence.authority) &&
  proofEvidenceShapes[authority].some(
    ([predicate, operation]) =>
      evidence.predicate_type === predicate && evidence.operation === operation,
  );

/** Check that Evidence observes the original at the required boundary. */
export const evidenceSupportsOriginalAuthority = (
  evidence: Evidence,
  authority: OriginalAuthority,
): boolean => {
  if (evidence.confidence !== "observed") return false;
  if (authority === "static") return evidence.authority === "shipped-artifact";
  if (authority === "runtime")
    return ["controlled-replay", "external-service"].includes(
      evidence.authority,
    );
  if (authority === "process")
    return (
      evidence.operation === "capture_process_scenario" &&
      evidence.predicate_type === "rea.process-capture/v4"
    );
  return evidence.authority === "external-service";
};
