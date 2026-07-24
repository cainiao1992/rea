import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { RECONSTRUCTION_READINESS_EXAMPLE } from "../src/contracts/reconstructionReadinessExample.js";

const execute = promisify(execFile);

describe("reconstruction readiness CLI parity", () => {
  it("emits the same passing report through the public CLI", async () => {
    const { stdout } = await execute(
      process.execPath,
      [
        "scripts/rea.mjs",
        "evaluate-reconstruction-readiness",
        JSON.stringify(RECONSTRUCTION_READINESS_EXAMPLE),
        "--json",
      ],
      {
        cwd: process.cwd(),
        env: process.env,
        maxBuffer: 32 * 1_024 * 1_024,
      },
    );
    expect(JSON.parse(stdout)).toMatchObject({
      operation: "evaluate_reconstruction_readiness",
      predicate_type: "rea.reconstruction-readiness-report/v1",
      normalized_result: {
        schema: "ReconstructionReadinessReport",
        status: "pass",
        summary: { passed_required_stages: 9 },
      },
    });
  }, 20_000);
});
