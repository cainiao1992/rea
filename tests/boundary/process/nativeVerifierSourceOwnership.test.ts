import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { z } from "zod";

import { processTest } from "../../support/process/processFixture.js";

const commandsModule = new URL(
  "../../../scripts/lib/verify-commands.mjs",
  import.meta.url,
).href;
const verifierModule = new URL(
  "../../../scripts/lib/verifier-run.mjs",
  import.meta.url,
).href;
const repository = fileURLToPath(new URL("../../../", import.meta.url));
const commandOutput = "authored native verifier command completed\n";

const reportSchema = z.object({
  command: z.object({ stdout: z.string(), stderr: z.string() }),
  verifier: z.object({
    process_lineage: z.discriminatedUnion("status", [
      z.object({
        status: z.literal("verified"),
        descendants: z.array(
          z.object({
            pid: z.number().int().positive(),
            parent_pid: z.number().int().positive(),
            process_group_id: z.number().int().positive(),
          }),
        ),
      }),
      z.object({ status: z.literal("unavailable"), reason: z.string() }),
    ]),
  }),
});

// This exercises the public source loader and real command cleanup. The lineage
// receipt is sampled inside the driver before its exit releases loader children.
// Windows has no native Job Object lease for this verifier lineage observation.
processTest.skipIf(process.platform === "win32")(
  "releases a cold native verifier source loader before reporting command cleanup complete",
  { timeout: 30_000 },
  async ({ processes }) => {
    const result = await processes.run(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
import { createVerifierRun, completeVerifierRun } from ${JSON.stringify(verifierModule)};
const run = createVerifierRun();
const { createVerifierCommands } = await import(${JSON.stringify(commandsModule)});
const commands = await createVerifierCommands();
let command;
try {
  command = await commands.exec(process.execPath, [
    "-e", ${JSON.stringify(`process.stdout.write(${JSON.stringify(commandOutput)})`)},
  ], { timeout: 5000 });
} finally {
  await commands.close();
}
const verifier = await completeVerifierRun(run);
process.stdout.write(JSON.stringify({ command, verifier }));
`,
      ],
      {
        cwd: repository,
        // Installed tsx reads this switch before choosing its transform cache.
        // A fresh process must transform source even when disk cache is warm.
        env: { ...process.env, TSX_DISABLE_CACHE: "1" },
        timeoutMs: 20_000,
      },
    );
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.signal, result.stderr).toBeNull();
    const report = reportSchema.parse(JSON.parse(result.stdout));
    expect(report.command).toEqual({ stdout: commandOutput, stderr: "" });
    expect(report.verifier.process_lineage).toEqual({
      status: "verified",
      descendants: [],
    });
  },
);
