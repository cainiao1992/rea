import { copyFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect } from "vitest";

import { workspaceCliTest } from "../../support/cli/workspaceCliFixture.js";
import type { TestWorkspace } from "../../support/workspace/workspaceFixture.js";

const CLI_OUTPUT_RUNTIME =
  "export const cliConfigurationError = () => undefined; export const normalizeCliArguments = (args) => args; export const parseCliOutputArguments = () => ({ validation: { ok: true } }); export const renderCliOutputArgumentError = () => ''; export const renderEmptyFilteredCliOutput = () => undefined; export const renderVersionReport = () => undefined;\n";

const installCliRuntime = async (
  workspace: TestWorkspace,
  cliSource: string,
  resultOutput = "export const createCliResultOutput = () => undefined;\n",
): Promise<void> => {
  await workspace.mkdir("scripts");
  await workspace.mkdir("dist/cli-runtime");
  await Promise.all([
    copyFile("scripts/rea.mjs", workspace.path("scripts/rea.mjs")),
    workspace.write(
      "package.json",
      JSON.stringify({ type: "module", version: "1.0.0" }),
    ),
    workspace.write("dist/cli-runtime/cli.js", cliSource),
    workspace.write("dist/cli-runtime/cliOutput.js", CLI_OUTPUT_RUNTIME),
    workspace.write("dist/cli-runtime/cliResultOutput.js", resultOutput),
  ]);
};

describe("version report dispatch", () => {
  workspaceCliTest(
    "reports formatted versions without loading analysis commands and preserves preflight errors",
    async ({ processes, workspace }) => {
      const blocked =
        'throw new Error("analysis command runtime was loaded");\n';
      await installCliRuntime(workspace, blocked, blocked);
      await workspace.write(
        "package.json",
        JSON.stringify({
          type: "module",
          name: "rea-fixture",
          version: "1.0.0",
        }),
      );
      // Use the built production preflight, while making full CLI imports fail.
      await workspace.write(
        "dist/cli-runtime/cliOutput.js",
        `export * from ${JSON.stringify(pathToFileURL(resolve("dist/cli-runtime/cliOutput.js")).href)};\n`,
      );
      const invoke = (arguments_: readonly string[], invalidLogLevel = false) =>
        processes.run(
          process.execPath,
          [workspace.path("scripts/rea.mjs"), ...arguments_],
          {
            cwd: workspace.root,
            env: {
              ...process.env,
              REA_LOG_LEVEL: invalidLogLevel ? "invalid-level" : "silent",
            },
          },
        );

      const report = await invoke(["--version", "--json"]);
      expect(report.exitCode, report.stderr).toBe(0);
      expect(JSON.parse(report.stdout)).toMatchObject({
        name: "rea-fixture",
        version: "1.0.0",
        runtime: { id: "node", version: process.versions.node },
      });
      const invalidOutput = await invoke([
        "--version",
        "--json",
        "--token-limit",
        "5",
      ]);
      expect(invalidOutput.exitCode, invalidOutput.stderr).toBe(1);
      expect(JSON.parse(invalidOutput.stdout)).toMatchObject({
        error: { code: "UNSUPPORTED_OUTPUT_COMBINATION" },
      });
      const invalidConfiguration = await invoke(["--version", "--json"], true);
      expect(invalidConfiguration.exitCode).toBe(1);
      expect(invalidConfiguration.stdout).toBe("");
      expect(invalidConfiguration.stderr).toContain("REA_LOG_LEVEL");
      expect(invalidConfiguration.stderr).not.toContain(
        "analysis command runtime was loaded",
      );
    },
  );
});

describe("executable dispatcher", () => {
  workspaceCliTest(
    "does not append recovery output after delegated stdout has begun",
    async ({ processes, workspace }) => {
      await installCliRuntime(
        workspace,
        'export const closeCliJavaScriptResources = () => {}; export const createCli = () => ({ serve: (_args, options) => { options.stdout("first document\\n"); throw new RangeError("Invalid string length"); } });\n',
        'export const createCliResultOutput = () => ({ handled: false, failed: false, captureSdkOutput: () => false, finishSdkOutput: async () => {}, recoverFormattingFailure: () => { process.stdout.write("unexpected second document"); return true; } });\n',
      );
      const result = await processes.run(
        process.execPath,
        [workspace.path("scripts/rea.mjs"), "fixture"],
        { cwd: workspace.root },
      );
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("first document\n");
      expect(result.stderr).toContain("RangeError: Invalid string length");
    },
  );

  workspaceCliTest(
    "reserves production MCP routing for bare mode arguments",
    async ({ processes, workspace }) => {
      const scripts = await workspace.mkdir("scripts");
      await workspace.mkdir("dist");
      await workspace.mkdir("dist/cli-runtime");
      await workspace.mkdir("dist/mcp");
      await Promise.all([
        copyFile("scripts/rea.mjs", join(scripts, "rea.mjs")),
        workspace.write(
          "package.json",
          JSON.stringify({ type: "module", version: "1.0.0" }),
        ),
        workspace.write(
          "dist/mcp/main.js",
          'export const runEntrypoint = () => process.stdout.write(JSON.stringify({ adapter: "mcp" })); export const runMcpHttpEntrypoint = (args) => process.stdout.write(JSON.stringify({ adapter: "mcp-http", args }));\n',
        ),
        workspace.write(
          "dist/cli-runtime/cli.js",
          'export const closeCliJavaScriptResources = () => {}; export const createCli = () => ({ serve: (args) => process.stdout.write(JSON.stringify({ adapter: "cli", args })) });\n',
        ),
        workspace.write("dist/cli-runtime/cliOutput.js", CLI_OUTPUT_RUNTIME),
        workspace.write(
          "dist/cli-runtime/cliResultOutput.js",
          "export const createCliResultOutput = () => undefined;\n",
        ),
        workspace.write(
          "dist/cli-runtime/mcpDoctor.js",
          'export const runProductionMcpDoctorCli = (args, input) => Promise.resolve({ output: JSON.stringify({ adapter: "mcp-doctor", args, stdoutIsTerminal: input.stdoutIsTerminal }), exitCode: 0 });\n',
        ),
      ]);

      const invoke = async (args: readonly string[]): Promise<unknown> => {
        const { exitCode, stdout } = await processes.run(
          process.execPath,
          [join(scripts, "rea.mjs"), ...args],
          { cwd: workspace.root },
        );
        expect(exitCode).toBe(0);
        return JSON.parse(stdout) as unknown;
      };

      await expect(invoke(["mcp"])).resolves.toEqual({ adapter: "mcp" });
      await expect(invoke(["--mcp"])).resolves.toEqual({ adapter: "mcp" });
      await expect(invoke(["mcp", "doctor", "--json"])).resolves.toEqual({
        adapter: "mcp-doctor",
        args: ["--json"],
        stdoutIsTerminal: false,
      });
      await expect(invoke(["mcp", "add"])).resolves.toEqual({
        adapter: "cli",
        args: ["mcp", "add"],
      });
      await expect(invoke(["--mcp", "extra"])).resolves.toEqual({
        adapter: "cli",
        args: ["--mcp", "extra"],
      });
      for (const args of [
        ["mcp", "--http", "--port", "0"],
        ["--mcp", "--http"],
        ["mcp", "-h", "--http"],
        ["mcp", "--host", "127.0.0.1", "--http"],
      ])
        await expect(invoke(args)).resolves.toEqual({
          adapter: "mcp-http",
          args: args.slice(1),
        });
      await expect(invoke(["mcp", "doctor", "--http"])).resolves.toEqual({
        adapter: "mcp-doctor",
        args: ["--http"],
        stdoutIsTerminal: false,
      });
      await expect(invoke(["mcp", "add", "--http"])).resolves.toEqual({
        adapter: "cli",
        args: ["mcp", "add", "--http"],
      });
    },
  );

  workspaceCliTest(
    "explains how to restore a missing compiled runtime",
    async ({ processes, workspace }) => {
      const scripts = await workspace.mkdir("scripts");
      await Promise.all([
        copyFile("scripts/rea.mjs", join(scripts, "rea.mjs")),
        workspace.write(
          "package.json",
          JSON.stringify({ type: "module", version: "1.0.0" }),
        ),
      ]);

      for (const args of [["mcp"], ["mcp", "doctor"], ["--help"]]) {
        const result = await processes.run(
          process.execPath,
          [join(scripts, "rea.mjs"), ...args],
          { cwd: workspace.root },
        );
        expect(result).toMatchObject({
          exitCode: 1,
          stderr: expect.stringContaining(
            "REA's compiled runtime is missing. Run `npm ci && npm run build:cached` in",
          ),
        });
        expect(result.stderr).toContain(
          "If this is an installed package, reinstall rea-agents.",
        );
        expect(result).toMatchObject({
          stderr: expect.not.stringContaining("ERR_MODULE_NOT_FOUND"),
        });
      }
    },
  );
});

describe("executable dispatcher JavaScript shutdown", () => {
  workspaceCliTest.for([
    "success",
    "cleanup-failure",
    "write-failure",
    "closed-pipe",
  ] as const)(
    "awaits SDK output after cleanup and retains finalization status: %s",
    async (scenario, { processes, workspace }) => {
      const cleanupFails = scenario === "cleanup-failure";
      const finish =
        scenario === "closed-pipe"
          ? 'process.stdout.emit("error", Object.assign(new Error("broken pipe"), { code: "EPIPE" })); throw new Error("broken pipe");'
          : scenario === "write-failure"
            ? 'throw new Error("final write failed");'
            : 'process.stdout.write("complete document\\n");';
      await installCliRuntime(
        workspace,
        `export const closeCliJavaScriptResources = () => { globalThis.cleaned = true; ${cleanupFails ? 'return Promise.reject(new Error("worker still owned"));' : ""} }; export const createCli = () => ({ serve: (_args, options) => { options.stdout("pending document"); options.exit(0); } });\n`,
        `export const createCliResultOutput = () => ({ handled: false, failed: false, captureSdkOutput: () => true, finishSdkOutput: async () => { if (!globalThis.cleaned) throw new Error("output preceded cleanup"); await new Promise(resolve => setTimeout(resolve, 10)); ${finish} } });\n`,
      );
      const result = await processes.run(
        process.execPath,
        [workspace.path("scripts/rea.mjs"), "fixture"],
        { cwd: workspace.root },
      );
      expect(result.exitCode).toBe(
        scenario === "closed-pipe" ? 141 : scenario === "success" ? 0 : 1,
      );
      expect(result.stdout).toBe(
        scenario === "success" || cleanupFails ? "complete document\n" : "",
      );
      expect(result.stderr).not.toContain("output preceded cleanup");
      if (cleanupFails) expect(result.stderr).toContain("worker still owned");
      if (scenario === "write-failure")
        expect(result.stderr).toContain("final write failed");
      if (scenario === "closed-pipe") expect(result.stderr).toBe("");
    },
  );

  workspaceCliTest(
    "reports a failed JavaScript worker shutdown instead of exiting successfully",
    async ({ processes, workspace }) => {
      await installCliRuntime(
        workspace,
        'export const closeCliJavaScriptResources = () => Promise.reject(new Error("worker still owned")); export const createCli = () => ({ serve: (_args, options) => { options.exit(0); } });\n',
      );
      const result = await processes.run(
        process.execPath,
        [workspace.path("scripts/rea.mjs"), "fixture"],
        { cwd: workspace.root },
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("worker still owned");
    },
  );

  workspaceCliTest(
    "keeps the closed-pipe status when JavaScript worker shutdown fails",
    async ({ processes, workspace }) => {
      await installCliRuntime(
        workspace,
        'export const closeCliJavaScriptResources = () => Promise.reject(new Error("worker still owned")); export const createCli = () => ({ serve: (_args, options) => { process.stdout.emit("error", Object.assign(new Error("broken pipe"), { code: "EPIPE" })); options.exit(0); } });\n',
      );
      const result = await processes.run(
        process.execPath,
        [workspace.path("scripts/rea.mjs"), "fixture"],
        { cwd: workspace.root },
      );
      expect(result.exitCode).toBe(141);
      expect(result.stderr).toContain("worker still owned");
    },
  );
});
