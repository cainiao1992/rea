import { describe, expect, it } from "vitest";

import { execFileOutput } from "./ExecFileOutput.js";

describe("execFileOutput", () => {
  it("captures output larger than Node's default execFile limit", async () => {
    const marker = "tail-marker";
    const result = await execFileOutput(process.execPath, [
      "-e",
      `process.stdout.write("x".repeat(2 * 1024 * 1024)); process.stdout.write(${JSON.stringify(marker)});`,
    ]);

    expect(result.stdout).toHaveLength(2 * 1024 * 1024 + marker.length);
    expect(result.stdout.endsWith(marker)).toBe(true);
  });
});
