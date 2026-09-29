import { describe, expect, it } from "vitest";

import { GHIDRA_MAX_LINE_BYTES } from "./GhidraDefaults.js";
import { GhidraResponseBuffer } from "./GhidraResponseBuffer.js";

describe("Ghidra response buffer", () => {
  it("accepts complete responses larger than the former 1 MiB ceiling", () => {
    const lines: string[] = [];
    const failures: string[] = [];
    const buffer = new GhidraResponseBuffer({
      maxLineBytes: GHIDRA_MAX_LINE_BYTES,
      onLine: (line) => lines.push(line),
      onFailure: (message) => failures.push(message),
    });
    const response = `{"result":"${"x".repeat(1_100_000)}"}`;

    buffer.push(`${response}\n`);

    expect(failures).toEqual([]);
    expect(lines).toEqual([response]);
  });
});
