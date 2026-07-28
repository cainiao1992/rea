import { createHash } from "node:crypto";

import canonicalize from "canonicalize";
import { z } from "zod";

import { evidenceEnvelopeSchema } from "./evidence.js";
import { evidenceBundleSchema } from "./evidenceBundle.js";

/** Schema version for the conformance package format. */
export const CONFORMANCE_PACKAGE_VERSION = 1;

/** A stable, path-independent identifier for a conformance package. */
export const conformancePackageIdSchema = z
  .string()
  .regex(/^cp_[a-f0-9]{64}$/u);

/** Identifier for a single scenario within a package. */
export const scenarioIdSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9._-]{0,99}$/u);

/** Deterministic manifest for a scenario fixture. */
export const scenarioManifestSchema = z.strictObject({
  scenario_id: scenarioIdSchema,
  name: z.string().min(1),
  description: z.string().min(1),
  /** Source-owned fixture path relative to the repository root. */
  fixture_path: z.string().min(1),
  /** Expected exit code or null if unspecified. */
  expected_exit_code: z.number().int().nullable(),
  /** Expected output patterns that must appear in the capture. */
  expected_patterns: z.array(z.string()).default([]),
});

/** Replay plan describing how a scenario is replayed deterministically. */
export const replayPlanSchema = z.strictObject({
  scenario_id: scenarioIdSchema,
  /** Ordered steps to execute during replay. */
  steps: z
    .array(
      z.strictObject({
        step_id: z.string().min(1),
        action: z.string().min(1),
        arguments: z.array(z.string()).default([]),
        timeout_ms: z.number().int().positive(),
      }),
    )
    .min(1)
    .max(100),
  /** Environment variables to set (never inherit host paths). */
  environment: z.record(z.string(), z.string()).default({}),
});

/** Shim plan for intercepting observable effects. */
export const shimPlanSchema = z.strictObject({
  scenario_id: scenarioIdSchema,
  /** Shims to install, each intercepting a named effect. */
  shims: z
    .array(
      z.strictObject({
        shim_id: z.string().min(1),
        kind: z.enum(["filesystem", "network", "process", "signal"]),
        target: z.string().min(1),
        policy: z.enum(["observe", "allow", "block", "emulate"]),
      }),
    )
    .min(0)
    .max(50),
});

/** Expected evidence for a scenario, checked against the captured run. */
export const expectedEvidenceSchema = z.strictObject({
  scenario_id: scenarioIdSchema,
  /** Expected evidence envelopes. */
  envelopes: z.array(evidenceEnvelopeSchema).min(0).max(100),
  /** Expected evidence bundle. */
  bundle: evidenceBundleSchema.nullable(),
  /** Required dimensions that must be present in the evidence. */
  required_dimensions: z.array(z.string().min(1)).default([]),
});

/** Verifier contract describing how to validate conformance. */
export const verifierContractSchema = z.strictObject({
  scenario_id: scenarioIdSchema,
  /** Dimensions to verify. */
  dimensions: z
    .array(
      z.strictObject({
        name: z.string().min(1),
        required: z.boolean().default(true),
        comparison: z.enum(["exact", "semantic", "fuzzy"]),
      }),
    )
    .min(1)
    .max(50),
  /** Tolerance for timing differences in milliseconds. */
  timing_tolerance_ms: z.number().int().nonnegative().default(0),
});

/** Top-level conformance package manifest. */
export const conformancePackageSchema = z.strictObject({
  schema_version: z.literal(CONFORMANCE_PACKAGE_VERSION),
  package_id: conformancePackageIdSchema,
  name: z.string().min(1),
  description: z.string().min(1),
  created_at: z.string().datetime(),
  /** Scenario manifests. */
  scenarios: z.array(scenarioManifestSchema).min(1).max(100),
  /** Replay plans keyed by scenario_id. */
  replay_plans: z.array(replayPlanSchema).min(1).max(100),
  /** Shim plans keyed by scenario_id. */
  shim_plans: z.array(shimPlanSchema).default([]),
  /** Expected evidence for each scenario. */
  expected_evidence: z.array(expectedEvidenceSchema).min(1).max(100),
  /** Verifier contracts for each scenario. */
  verifier_contracts: z.array(verifierContractSchema).min(1).max(100),
});

export type ConformancePackage = z.infer<typeof conformancePackageSchema>;
export type ScenarioManifest = z.infer<typeof scenarioManifestSchema>;
export type ReplayPlan = z.infer<typeof replayPlanSchema>;
export type ShimPlan = z.infer<typeof shimPlanSchema>;
export type ExpectedEvidence = z.infer<typeof expectedEvidenceSchema>;
export type VerifierContract = z.infer<typeof verifierContractSchema>;

/** Error from validation or package operations. */
export type ConformancePackageError =
  | { kind: "invalid_package"; message: string }
  | { kind: "scenario_not_found"; scenario_id: string }
  | { kind: "duplicate_scenario"; scenario_id: string };

/** Result type for package operations. */
export type ConformancePackageResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ConformancePackageError };

/** Validate a conformance package and cross-check internal references. */
export function validateConformancePackage(
  input: unknown,
): ConformancePackageResult<ConformancePackage> {
  const parsed = conformancePackageSchema.safeParse(input);
  if (!parsed.success)
    return {
      ok: false,
      error: {
        kind: "invalid_package",
        message: parsed.error.issues[0]?.message ?? "invalid package",
      },
    };

  const pkg = parsed.data;

  // Check for duplicate scenario IDs
  const seen = new Set<string>();
  for (const s of pkg.scenarios) {
    if (seen.has(s.scenario_id))
      return {
        ok: false,
        error: { kind: "duplicate_scenario", scenario_id: s.scenario_id },
      };
    seen.add(s.scenario_id);
  }

  // Check that replay plans reference existing scenarios
  for (const rp of pkg.replay_plans) {
    if (!seen.has(rp.scenario_id))
      return {
        ok: false,
        error: {
          kind: "scenario_not_found",
          scenario_id: rp.scenario_id,
        },
      };
  }

  // Check that expected evidence references existing scenarios
  for (const ee of pkg.expected_evidence) {
    if (!seen.has(ee.scenario_id))
      return {
        ok: false,
        error: {
          kind: "scenario_not_found",
          scenario_id: ee.scenario_id,
        },
      };
  }

  // Check that verifier contracts reference existing scenarios
  for (const vc of pkg.verifier_contracts) {
    if (!seen.has(vc.scenario_id))
      return {
        ok: false,
        error: {
          kind: "scenario_not_found",
          scenario_id: vc.scenario_id,
        },
      };
  }

  return { ok: true, value: pkg };
}

/** Compute a deterministic package ID from the canonical JSON. */
export function computePackageId(
  pkg: Omit<ConformancePackage, "package_id">,
): string {
  const json = canonicalize(pkg);
  if (!json) throw new Error("failed to canonicalize package");
  return `cp_${createHash("sha256").update(json).digest("hex")}`;
}

/** Create a conformance package with an auto-computed package_id. */
export function createConformancePackage(
  pkg: Omit<ConformancePackage, "package_id">,
): ConformancePackage {
  const package_id = computePackageId(pkg);
  return { package_id, ...pkg };
}
