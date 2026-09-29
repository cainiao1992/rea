import { describe, expect, it } from "vitest";

import { GhidraResponseBuffer } from "./GhidraResponseBuffer.js";

describe("Ghidra response buffer", () => {
  it("accepts complete responses larger than the former 64 MiB ceiling", () => {
    const lines: string[] = [];
    const buffer = new GhidraResponseBuffer({
      onLine: (line) => lines.push(line),
    });
    const response = `{"result":"${"x".repeat(64 * 1024 * 1024 + 1)}"}`;

    buffer.push(`${response}\n`);

    expect(lines).toEqual([response]);
  });
});
