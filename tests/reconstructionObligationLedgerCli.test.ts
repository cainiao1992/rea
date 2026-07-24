import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { createEvidenceBundle } from "../src/domain/evidenceBundle.js";

const execute = promisify(execFile);

describe("reconstruction obligation ledger CLI parity", () => {
  it("builds the same Evidence-backed empty ledger through the CLI", async () => {
    const input = {
      evidence_bundle: createEvidenceBundle([]),
      reviewed_obligations: [],
      manifest: {
        schema_version: 1,
        bindings: [],
        contradictions: [],
      },
      limits: { max_obligations: 100 },
      page: { offset: 0, limit: 50 },
    };
    const { stdout } = await execute(
      process.execPath,
      [
        "scripts/rea.mjs",
        "build-reconstruction-obligation-ledger",
        JSON.stringify(input),
        "--json",
      ],
      {
        cwd: process.cwd(),
        env: process.env,
        maxBuffer: 16 * 1_024 * 1_024,
      },
    );
    expect(JSON.parse(stdout)).toMatchObject({
      operation: "build_reconstruction_obligation_ledger",
      predicate_type: "rea.reconstruction-obligation-ledger/v1",
      normalized_result: {
        schema: "ReconstructionObligationLedger",
        status: "unknown",
        summary: { total: 0 },
      },
    });
  }, 20_000);
});
