import { createHash } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import { nativeCallObservationInputSchema } from "../../../../src/domain/native/nativeCallObservation.js";
import { resolveXcrunTool } from "../../../../src/native/CommandRunner.js";
import { LldbCallTracer } from "../../../../src/native/LldbCallTracer.js";
import { observeProcessStartIdentity } from "../../../../src/process/ProcessOwnershipObservation.js";
import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";

const readySchema = z.object({
  pid: z.int().positive(),
  run_id: z.string().min(1),
  config_path: z.string(),
});
const shellArgument = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

it.skipIf(process.platform !== "darwin")(
  "cleans an xcrun-selected LLDB wrapper after cancellation without requiring its pre-exec argv",
  async () => {
    const root = await createTestTempDirectory("rea-lldb-wrapper-");
    const child = join(root, "safe-child.mjs");
    const toolchains = join(root, "Toolchains");
    const toolchain = join(toolchains, "Audit.xctoolchain");
    const launcher = join(toolchain, "usr/bin/lldb");
    const readyPath = join(root, "ready.json");
    await mkdir(dirname(launcher), { recursive: true });
    // LLVM documents this external toolchain layout and selection mechanism:
    // llvm/tools/xcode-toolchain/CMakeLists.txt. No installed toolchain is changed.
    await writeFile(
      join(toolchain, "Info.plist"),
      `<?xml version="1.0"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>org.rea.audit.lldb</string>
<key>CompatibilityVersion</key><integer>2</integer>
</dict></plist>`,
    );
    // This producer launches no debugger or target. Its delayed self-exit also
    // bounds the baseline regression's deliberately refused cleanup.
    await writeFile(
      child,
      `import { readFileSync, writeFileSync } from 'node:fs';
const command = process.argv.find(value => value.startsWith('rea_trace '));
const configPath = command.slice('rea_trace '.length);
const config = JSON.parse(readFileSync(configPath, 'utf8'));
writeFileSync(config.result_path, JSON.stringify({
  status: 'launch-error', error: 'fixture deliberately launches no target',
  target_process_created: false, target_process_exit_observed: true
}));
for (const path of [config.observation_path, config.stdout_capture_path, config.stderr_capture_path])
  writeFileSync(path, '');
writeFileSync(${JSON.stringify(readyPath)}, JSON.stringify({
  pid: process.pid, run_id: process.env.REA_PROCESS_RUN_ID, config_path: configPath
}));
setTimeout(() => process.exit(0), 10000);
`,
    );
    const launcherText = `#!/bin/sh\nexec ${shellArgument(process.execPath)} ${shellArgument(child)} "$@"\n`;
    await writeFile(launcher, launcherText);
    await chmod(launcher, 0o755);
    const environment = {
      ...process.env,
      DEVELOPER_DIR: undefined,
      SDKROOT: undefined,
      EXTERNAL_TOOLCHAINS_DIR: toolchains,
      TOOLCHAINS: "org.rea.audit.lldb",
      xcrun_nocache: "1",
    };
    const selected = await resolveXcrunTool("lldb", environment);
    if (!selected.ok) throw selected.error;
    expect(selected.value).toEqual({
      path: await realpath(launcher),
      sha256: createHash("sha256").update(launcherText).digest("hex"),
    });
    // Production discovery, acquisition and native process ownership terminate
    // the real child reached through this caller-selected external toolchain.
    const tracer = new LldbCallTracer(environment);
    const controller = new AbortController();
    const reason = new Error("caller cancels the acquired wrapper fixture");
    let started: z.infer<typeof readySchema> | undefined;
    try {
      const pending = tracer.trace(
        {
          executable: "/fixture/target-is-never-launched",
          architecture: "arm64",
          expectedSha256: "b".repeat(64),
          input: nativeCallObservationInputSchema.parse({
            breakpoints: [{ kind: "function", name: "main" }],
            duration_ms: 100,
          }),
        },
        controller.signal,
      );
      await expect
        .poll(
          async () => {
            started = readySchema.parse(
              JSON.parse(await readFile(readyPath, "utf8")),
            );
            return started.run_id;
          },
          { timeout: 5_000 },
        )
        .toEqual(expect.any(String));
      if (started === undefined) throw new Error("Wrapper did not start");
      const identity = await observeProcessStartIdentity(
        started.pid,
        undefined,
        started.run_id,
      );
      expect(identity?.state).toBe("readable");
      controller.abort(reason);
      const result = await pending;
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Expected caller cancellation");
      expect(result.error).toMatchObject({
        _tag: "AnalysisCancelledError",
        cause: reason,
        cleanupIncomplete: false,
      });
      expect(await observeProcessStartIdentity(started.pid)).toBeUndefined();
      await expect(access(dirname(started.config_path))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      controller.abort(reason);
      const closed = await tracer.close();
      if (!closed.ok && started !== undefined) {
        // The unpatched implementation retains its exact owner until the safe
        // fixture self-exits. Do not bypass ownership with an unverified PID kill.
        const pid = started.pid;
        await expect
          .poll(async () => await observeProcessStartIdentity(pid), {
            timeout: 12_000,
          })
          .toBeUndefined();
        expect((await tracer.close()).ok).toBe(true);
      } else expect(closed.ok).toBe(true);
    }
  },
  15_000,
);
