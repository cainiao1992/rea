import { describe, expect, it } from "vitest";

import { completeReconstructionCoverageData } from "../domain/reconstructionCoverage.fixture.js";
import { reconstructionCoverageEvaluationInputSchema } from "./ReconstructionCoverageService.js";

describe("reconstruction coverage service input", () => {
  it("accepts caller boundary identifiers longer than the former schema ceiling", () => {
    const boundaryId = "b".repeat(1_000);
    const parsed = reconstructionCoverageEvaluationInputSchema.parse({
      coverage: completeReconstructionCoverageData(),
      boundary_id: boundaryId,
    });

    expect(parsed.boundary_id).toBe(boundaryId);
  });
});
