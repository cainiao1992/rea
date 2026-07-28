import { z } from "zod";

import type {
  ConformancePackage,
  VerifierContract,
} from "./conformancePackage.js";

/** Result of comparing a single dimension. */
export const dimensionResultSchema = z.strictObject({
  name: z.string().min(1),
  status: z.enum(["match", "mismatch", "unknown", "truncated"]),
  message: z.string().default(""),
  evidence_ids: z.array(z.string()).default([]),
});

/** Result of evaluating a trust gate for one scenario. */
export const trustGateResultSchema = z.strictObject({
  scenario_id: z.string().min(1),
  verdict: z.enum(["pass", "fail", "unknown"]),
  dimension_results: z.array(dimensionResultSchema),
  first_divergence: z
    .strictObject({
      dimension: z.string().min(1),
      evidence_id: z.string().min(1),
      message: z.string(),
    })
    .nullable(),
});

export type DimensionResult = z.infer<typeof dimensionResultSchema>;
export type TrustGateResult = z.infer<typeof trustGateResultSchema>;

/** Dimension that is volatile due to timing or normalization. */
const VOLATILE_DIMENSIONS = new Set([
  "timing",
  "timestamp",
  "pid",
  "ppid",
  "duration_ms",
  "created_at",
  "updated_at",
]);

/** Dimension that carries semantic content. */
const SEMANTIC_DIMENSIONS = new Set([
  "exit_code",
  "stdout",
  "stderr",
  "filesystem",
  "process_tree",
  "shim_events",
  "protocol_events",
  "event_journal",
]);

/** Check if a dimension name is volatile (timing/normalization noise). */
export function isVolatileDimension(name: string): boolean {
  return VOLATILE_DIMENSIONS.has(name);
}

/** Check if a dimension name carries semantic content. */
export function isSemanticDimension(name: string): boolean {
  return SEMANTIC_DIMENSIONS.has(name);
}

/**
 * Compare two values for a dimension, classifying semantic diffs
 * from timing/normalization noise.
 *
 * Volatile dimensions (timing, timestamps, PIDs) are always treated
 * as matches because their values are expected to differ across
 * runs and do not carry semantic meaning.
 */
export function compareDimension(
  dimensionName: string,
  expected: unknown,
  actual: unknown,
  options: { truncated?: boolean } = {},
): DimensionResult {
  // Volatile dimensions: always match regardless of values
  if (isVolatileDimension(dimensionName)) {
    return {
      name: dimensionName,
      status: "match",
      message: "volatile dimension ignored",
      evidence_ids: [],
    };
  }

  if (options.truncated) {
    return {
      name: dimensionName,
      status: "truncated",
      message: "evidence was truncated",
      evidence_ids: [],
    };
  }

  if (expected === undefined && actual === undefined) {
    return {
      name: dimensionName,
      status: "unknown",
      message: "both expected and actual are undefined",
      evidence_ids: [],
    };
  }

  if (expected === undefined || actual === undefined) {
    return {
      name: dimensionName,
      status: "mismatch",
      message: `expected ${expected === undefined ? "present" : "absent"}, actual ${actual === undefined ? "absent" : "present"}`,
      evidence_ids: [],
    };
  }

  // Semantic comparison for structured objects
  if (typeof expected === "object" && typeof actual === "object") {
    const expectedJson = JSON.stringify(sortKeys(expected));
    const actualJson = JSON.stringify(sortKeys(actual));
    if (expectedJson === actualJson) {
      return {
        name: dimensionName,
        status: "match",
        message: "",
        evidence_ids: [],
      };
    }
    return {
      name: dimensionName,
      status: "mismatch",
      message: "semantic content differs",
      evidence_ids: [],
    };
  }

  // Primitive comparison
  if (expected === actual) {
    return {
      name: dimensionName,
      status: "match",
      message: "",
      evidence_ids: [],
    };
  }

  return {
    name: dimensionName,
    status: "mismatch",
    message: `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    evidence_ids: [],
  };
}

/** Recursively sort object keys for deterministic comparison. */
function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortKeys);
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
  }
  return sorted;
}

/**
 * Evaluate a trust gate for one scenario by comparing expected
 * evidence against the actual captured run.
 */
export function evaluateTrustGate(
  contract: VerifierContract,
  expectedEvidence: Record<string, unknown>,
  actualEvidence: Record<string, unknown>,
  options: { truncated?: boolean } = {},
): TrustGateResult {
  const dimensionResults: DimensionResult[] = [];
  let firstDivergence: TrustGateResult["first_divergence"] = null;

  for (const dim of contract.dimensions) {
    if (!dim.required) continue;
    const expectedValue = expectedEvidence[dim.name];
    const actualValue = actualEvidence[dim.name];
    const result = compareDimension(
      dim.name,
      expectedValue,
      actualValue,
      options,
    );
    dimensionResults.push(result);

    if (result.status === "mismatch" && firstDivergence === null) {
      firstDivergence = {
        dimension: dim.name,
        evidence_id: result.evidence_ids[0] ?? "unknown",
        message: result.message,
      };
    }
  }

  const hasFail = dimensionResults.some(
    (r) => r.status === "mismatch" || r.status === "truncated",
  );
  const hasUnknown = dimensionResults.some((r) => r.status === "unknown");

  const verdict: TrustGateResult["verdict"] = hasFail
    ? "fail"
    : hasUnknown
      ? "unknown"
      : "pass";

  return {
    scenario_id: contract.scenario_id,
    verdict,
    dimension_results: dimensionResults,
    first_divergence: firstDivergence,
  };
}

/**
 * Evaluate trust gates for all scenarios in a conformance package.
 * Rejects runs that differ in required dimensions. Unknown/truncated
 * evidence is never treated as equivalence.
 */
export function evaluatePackageTrustGates(
  pkg: ConformancePackage,
  actualEvidence: Record<string, Record<string, unknown>>,
  options: { truncated?: boolean } = {},
): TrustGateResult[] {
  const results: TrustGateResult[] = [];
  for (const contract of pkg.verifier_contracts) {
    const expected = pkg.expected_evidence.find(
      (e) => e.scenario_id === contract.scenario_id,
    );
    if (!expected) continue;
    const expectedEvidence = expected.envelopes[0] ?? {};
    const actual = actualEvidence[contract.scenario_id] ?? {};
    const result = evaluateTrustGate(
      contract,
      expectedEvidence as Record<string, unknown>,
      actual,
      options,
    );
    results.push(result);
  }
  return results;
}
