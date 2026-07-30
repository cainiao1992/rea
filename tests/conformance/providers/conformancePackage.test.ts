import { describe, expect, it } from "vitest";

import {
  CONFORMANCE_PACKAGE_VERSION,
  conformancePackageSchema,
  computePackageId,
  createConformancePackage,
  validateConformancePackage,
  type ScenarioManifest,
  type ReplayPlan,
  type ShimPlan,
  type ExpectedEvidence,
} from "../../../src/domain/conformancePackage.js";

const validPackage = createConformancePackage({
  schema_version: CONFORMANCE_PACKAGE_VERSION,
  name: "test-fixture",
  description: "A test conformance fixture",
  created_at: "2026-07-28T00:00:00Z",
  scenarios: [
    {
      scenario_id: "s1",
      name: "Simple spawn",
      description: "A simple process spawn scenario",
      fixture_path: "tests/conformance/c/fixture.c",
      expected_exit_code: 0,
      expected_patterns: ["Hello", "World"],
    },
  ],
  replay_plans: [
    {
      scenario_id: "s1",
      steps: [
        {
          step_id: "step1",
          action: "compile",
          arguments: ["gcc", "fixture.c"],
          timeout_ms: 5000,
        },
      ],
      environment: {},
    },
  ],
  shim_plans: [],
  expected_evidence: [
    {
      scenario_id: "s1",
      envelopes: [],
      bundle: null,
      required_dimensions: ["exit_code", "stdout"],
    },
  ],
  verifier_contracts: [
    {
      scenario_id: "s1",
      dimensions: [
        {
          name: "exit_code",
          required: true,
          comparison: "exact",
        },
      ],
      timing_tolerance_ms: 100,
    },
  ],
});

describe("conformance package format", () => {
  it("validates a well-formed package", () => {
    const result = validateConformancePackage(validPackage);
    expect(result.ok).toBe(true);
  });

  it("rejects invalid schema version", () => {
    const result = validateConformancePackage({
      ...validPackage,
      schema_version: 999,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects duplicate scenario IDs", () => {
    const result = validateConformancePackage({
      ...validPackage,
      scenarios: [validPackage.scenarios[0], validPackage.scenarios[0]],
    });
    expect(result.ok).toBe(false);
  });

  it("rejects replay plan referencing non-existent scenario", () => {
    const result = validateConformancePackage({
      ...validPackage,
      replay_plans: [
        {
          scenario_id: "nonexistent",
          steps: [
            {
              step_id: "step1",
              action: "run",
              arguments: [],
              timeout_ms: 1000,
            },
          ],
          environment: {},
        },
      ],
    });
    expect(result.ok).toBe(false);
  });

  it("rejects verifier contract referencing non-existent scenario", () => {
    const result = validateConformancePackage({
      ...validPackage,
      verifier_contracts: [
        {
          scenario_id: "nonexistent",
          dimensions: [
            { name: "exit_code", required: true, comparison: "exact" },
          ],
          timing_tolerance_ms: 0,
        },
      ],
    });
    expect(result.ok).toBe(false);
  });

  it("rejects expected evidence referencing non-existent scenario", () => {
    const result = validateConformancePackage({
      ...validPackage,
      expected_evidence: [
        {
          scenario_id: "nonexistent",
          envelopes: [],
          bundle: null,
          required_dimensions: [],
        },
      ],
    });
    expect(result.ok).toBe(false);
  });

  it("computes a deterministic package ID", () => {
    const id = computePackageId({
      ...validPackage,
    });
    expect(id).toMatch(/^cp_[a-f0-9]{64}$/u);
    // Same input yields same ID
    const id2 = computePackageId({
      ...validPackage,
    });
    expect(id).toBe(id2);
  });

  it("produces different IDs for different packages", () => {
    const id1 = computePackageId({ ...validPackage, name: "packageA" });
    const id2 = computePackageId({ ...validPackage, name: "packageB" });
    expect(id1).not.toBe(id2);
  });

  it("uses all exported types", () => {
    const scenario: ScenarioManifest = validPackage.scenarios[0]!;
    expect(scenario.scenario_id).toBe("s1");

    const replay: ReplayPlan = validPackage.replay_plans[0]!;
    expect(replay.scenario_id).toBe("s1");

    const shim: ShimPlan = validPackage.shim_plans[0] ?? {
      scenario_id: "s1",
      shims: [],
    };
    expect(shim.scenario_id).toBe("s1");

    const evidence: ExpectedEvidence = validPackage.expected_evidence[0]!;
    expect(evidence.scenario_id).toBe("s1");
  });

  it("parses via zod schema", () => {
    const result = conformancePackageSchema.safeParse(validPackage);
    expect(result.success).toBe(true);
  });
});
