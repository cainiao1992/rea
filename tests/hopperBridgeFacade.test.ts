import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";
import { z } from "zod";

const execute = promisify(execFile);
const bridgePath = new URL("../bridge/hopper_bridge.py", import.meta.url);
const probePath = new URL(
  "./fixtures/hopperBridgeFacadeProbe.py",
  import.meta.url,
);

const probeResultSchema = z.strictObject({
  imported_without_hopper: z.strictObject({
    type: z.literal("CapabilityUnavailableError"),
    diagnostic_type: z.literal("capability_unavailable"),
  }),
  current_document: z.literal("fixture"),
  current_address: z.literal("0x401000"),
  session_document: z.literal("fixture"),
  analysis_guard: z.strictObject({
    type: z.literal("CapabilityUnavailableError"),
    diagnostic_type: z.literal("capability_unavailable"),
    message: z.string(),
  }),
});

describe("Hopper API facade", () => {
  it("imports without Hopper globals and gates exhaustive work during analysis", async () => {
    const { stdout } = await execute(
      "python3",
      [probePath.pathname, bridgePath.pathname],
      {
        encoding: "utf8",
        timeout: 3_000,
        maxBuffer: 1_024 * 1_024,
      },
    );
    const result = probeResultSchema.parse(JSON.parse(stdout));
    expect(result.analysis_guard.message).toContain(
      "requires completed Hopper background analysis",
    );
  });
});
