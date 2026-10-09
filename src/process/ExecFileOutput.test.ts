import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";

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

  it("enforces a caller supplied output bound", async () => {
    await expect(
      execFileOutput(
        process.execPath,
        ["-e", 'process.stdout.write("x".repeat(1024))'],
        { maxBuffer: 64 },
      ),
    ).rejects.toMatchObject({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" });
  });

  it("retains both captured streams on a failed child process", async () => {
    await expect(
      execFileOutput(process.execPath, [
        "-e",
        'process.stdout.write("out"); process.stderr.write("err"); process.exitCode = 7;',
      ]),
    ).rejects.toMatchObject({ code: 7, stdout: "out", stderr: "err" });
  });

  it.skipIf(process.platform === "win32")(
    "stops an aborted process with the caller's signal and settles after it exits",
    async () => {
      const directory = await createTestTempDirectory("rea-exec-stop-");
      const ready = join(directory, "ready");
      const stopped = join(directory, "stopped");
      // The child records the signal it received only after a cleanup delay.
      const script = [
        'const fs = require("node:fs");',
        'for (const name of ["SIGINT", "SIGTERM"])',
        `  process.on(name, () => setTimeout(() => { fs.writeFileSync(${JSON.stringify(stopped)}, name); process.exit(0); }, 200));`,
        `fs.writeFileSync(${JSON.stringify(ready)}, "");`,
        "setInterval(() => {}, 1000);",
      ].join("\n");
      const controller = new AbortController();
      const execution = execFileOutput(process.execPath, ["-e", script], {
        signal: controller.signal,
        stopSignal: "SIGINT",
      }).then(
        () => undefined,
        async (cause: unknown) => ({
          cause,
          stoppedBeforeSettling: await readFile(stopped, "utf8").catch(
            () => null,
          ),
        }),
      );
      for (let attempt = 0; attempt < 500; attempt += 1) {
        if (
          await access(ready).then(
            () => true,
            () => false,
          )
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      controller.abort();
      const outcome = await execution;

      expect(outcome?.cause).toMatchObject({ name: "AbortError" });
      expect(outcome?.stoppedBeforeSettling).toBe("SIGINT");
    },
  );

  it("rejects an already aborted stoppable command without starting it", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      execFileOutput(process.execPath, ["-e", ""], {
        signal: controller.signal,
        stopSignal: "SIGINT",
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
