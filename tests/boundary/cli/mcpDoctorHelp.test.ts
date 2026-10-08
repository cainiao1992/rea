import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { expect, it } from "vitest";

const execute = promisify(execFile);

const runCli = async (arguments_: readonly string[]) => {
  try {
    const result = await execute(process.execPath, ["scripts/rea.mjs", ...arguments_], {
      cwd: process.cwd(),
      env: { ...process.env, REA_LOG_LEVEL: "silent" },
      timeout: 15_000,
    });
    return { exitCode: 0, ...result };
  } catch (cause: unknown) {
    if (
      typeof cause === "object" &&
      cause !== null &&
      "code" in cause &&
      typeof cause.code === "number" &&
      "stdout" in cause &&
      typeof cause.stdout === "string" &&
      "stderr" in cause &&
      typeof cause.stderr === "string"
    )
      return {
        exitCode: cause.code,
        stdout: cause.stdout,
        stderr: cause.stderr,
      };
    throw cause;
  }
};

it("shows MCP doctor help without starting a server and keeps option errors actionable", async () => {
  const parentHelp = await runCli(["mcp", "--help"]);
  expect(parentHelp.exitCode).toBe(0);
  expect(parentHelp.stdout).toContain("doctor");

  const help = await runCli(["mcp", "doctor", "--help"]);
  expect(help.exitCode).toBe(0);
  expect(help.stdout).toContain("Usage: rea mcp doctor [options]");
  expect(help.stdout).toContain("--format <format>");
  expect(help.stdout).toContain("--full-output");

  const invalid = await runCli(["mcp", "doctor", "--not-an-option"]);
  expect(invalid.exitCode).toBe(1);
  expect(invalid.stdout).toContain("Unknown mcp doctor option: --not-an-option");
});
