import { chmod, copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { cliTest } from "../../support/cli/cliFixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import {
  analysisCliErrorEnvelopeSchema,
  analysisErrorProjectionSchema,
} from "../../../src/contracts/errorSchemas.js";
import { parseEvidence } from "../../../src/domain/evidence.js";

cliTest.skipIf(process.platform === "win32")(
  "projects accepted Hopper regex operation through the public CLI with exact bridge request context",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-hopper-regex-cli-");
    const launcher = join(root, "fake-hopper.mjs"),
      target = join(root, "sample");
    await copyFile(
      fileURLToPath(
        new URL("../../fixtures/hopperRegexCliLauncher.mjs", import.meta.url),
      ),
      launcher,
    );
    await chmod(launcher, 0o700);
    await copyFile("/usr/bin/true", target);
    for (const kind of ["strings", "procedures"] as const)
      for (const mode of [
        "capability_unavailable",
        "bridge_exception",
        "valid",
      ] as const) {
        const home = join(root, `${kind}-${mode}`),
          trace = join(home, "trace");
        await mkdir(home);
        const run = await cli.run({
          arguments: [
            "search",
            target,
            "fixture",
            "--provider",
            "hopper",
            "--kind",
            kind,
            "--mode",
            "regex",
            "--json",
          ],
          environment: {
            HOME: home,
            TMPDIR: home,
            PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
            HOPPER_LAUNCHER_PATH: launcher,
            REA_LOG_LEVEL: "silent",
            REA_TEST_HOPPER_REGEX_MODE: mode,
            REA_TEST_HOPPER_TRACE: trace,
          },
        });
        expect(run.stderr).toBe("");
        expect((await readFile(trace, "utf8")).trim().split("\n")).toEqual([
          "health",
          `list_${kind}`,
          "shutdown_document",
        ]);
        if (mode === "valid") {
          expect(run.exitCode).toBe(0);
          const evidence = parseEvidence(run.json);
          expect(evidence.operation).toBe(`search_${kind}`);
          expect(evidence.normalized_result).toEqual([
            { address: "0x1000", value: "fixture" },
          ]);
        } else {
          expect(run.exitCode).toBe(1);
          const { error: label, ...projection } =
            analysisCliErrorEnvelopeSchema.parse(run.json);
          expect(label).not.toBe("");
          const error = analysisErrorProjectionSchema.parse(projection);
          expect(error.code, JSON.stringify(error)).toBe(
            mode === "capability_unavailable"
              ? "capability_unavailable"
              : "execution_failure",
          );
          expect(error.details).toMatchObject({
            operation: `search_${kind}`,
            diagnostics: {
              provider_request: {
                operation: `list_${kind}`,
                request_id: expect.any(Number),
                provider_code: -32000,
                diagnostic_type: mode,
              },
            },
          });
          if (mode === "bridge_exception")
            expect(error.message).toContain(`search_${kind}`);
        }
      }
  },
);
