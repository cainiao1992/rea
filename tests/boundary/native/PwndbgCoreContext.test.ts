import { access, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { AnalysisCancelledError } from "../../../src/domain/analysisErrorCore.js";
import { ArtifactResourceScope } from "../../../src/artifacts/ArtifactResourceScope.js";
import {
  createTestWorkspace,
  removeTestWorkspace,
} from "../../../tests/support/workspace/workspaceFixture.js";
import { inspectPwndbgCore } from "../../../src/native/pwndbg/PwndbgCoreContext.js";

const diagnostics = { stdout: "", stderr: "", truncated: false };

it.each(["pre-aborted", "aborted-during-probe"] as const)(
  "cancellation wins over debugger path failures: %s",
  async (scenario) => {
    const workspace = await createTestWorkspace("rea-pwndbg-cancel-");
    onTestFinished(() => removeTestWorkspace(workspace.root));
    const controller = new AbortController();
    const reason = { cancelled: scenario };
    const gdb = join(workspace.root, "missing-gdb");
    let probes = 0;
    const probePath = async () => {
      probes++;
      if (scenario === "aborted-during-probe") {
        await new Promise<void>((resolve) => {
          setImmediate(() => {
            controller.abort(reason);
            resolve();
          });
        });
        throw new Error("path became unavailable");
      }
      throw new Error("path is unavailable");
    };
    if (scenario === "pre-aborted") controller.abort(reason);
    const inspection = inspectPwndbgCore({
      environment: {
        REA_PWNDBG_GDB: gdb,
        REA_PWNDBG_GDBINIT: join(workspace.root, "missing-init"),
        REA_PWNDBG_VENV_PATH: join(workspace.root, "missing-venv"),
      },
      architecture: "x86_64-little-endian",
      rootPath: workspace.root,
      resources: new ArtifactResourceScope(),
      diagnostics,
      options: { signal: controller.signal },
      probePath,
      runCommand: () => {
        throw new Error("No process should exist before cancellation");
      },
    });
    const failure = await inspection.catch((cause: unknown) => cause);
    if (!(failure instanceof AnalysisCancelledError))
      throw new Error(
        "Expected cancellation at the debugger admission boundary",
      );
    expect(failure.cause).toBe(reason);
    expect(probes).toBe(scenario === "pre-aborted" ? 0 : 1);
    await expect(
      access(join(workspace.root, "debugger")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);

const execute = promisify(execFile);

it("establishes core-only debugger state before querying recorded mappings", async () => {
  await execute(
    "python3",
    ["-m", "unittest", "bridge/pwndbg/test_core_context.py", "-v"],
    {
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    },
  );
});

it.each(["x86_64-little-endian", "aarch64-little-endian"] as const)(
  "passes the validated %s profile to the debugger without reinterpreting core bytes",
  async (architecture) => {
    const workspace = await createTestWorkspace("rea-pwndbg-profile-");
    onTestFinished(() => removeTestWorkspace(workspace.root));
    let requested = false;
    await expect(
      inspectPwndbgCore({
        architecture,
        environment: {
          REA_PWNDBG_GDB: join(workspace.root, "gdb"),
          REA_PWNDBG_GDBINIT: join(workspace.root, "gdbinit.py"),
          REA_PWNDBG_VENV_PATH: join(workspace.root, "venv"),
        },
        rootPath: workspace.root,
        resources: new ArtifactResourceScope(),
        diagnostics,
        options: undefined,
        probePath: async () => {},
        runCommand: async () => {
          const request: unknown = JSON.parse(
            await readFile(
              join(workspace.root, "debugger", "request.json"),
              "utf8",
            ),
          );
          expect(request).toMatchObject({
            architecture,
            snapshot_path: join(workspace.root, "object.snapshot"),
          });
          requested = true;
          throw new Error("Stop after observing the debugger request");
        },
      }),
    ).rejects.toBeDefined();
    expect(requested).toBe(true);
  },
);
