import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it, onTestFinished, vi } from "vitest";
import { z } from "zod";

import { createCli } from "../../src/cli.js";
import { compareEvidenceBundlesCommand } from "../../src/application/EvidenceBundleCommands.js";
import { bundleComparisonResultSchema } from "../../src/domain/bundleComparison.js";
import { processEvidence } from "../../src/application/ReconstructionObligationLedger.fixture.js";
import { processCaptureSchema } from "../../src/domain/process/processCapture.js";
import {
  createEvidenceBundle,
  serializeEvidenceBundle,
} from "../../src/domain/evidenceBundle.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";

it.each([
  new TypeError("capture validation implementation failed"),
  new Error("capture validator failed"),
  new z.ZodError([
    { code: "custom", path: [], message: "capture refinement failed" },
  ]),
])(
  "preserves unexpected process validation failures while reading a bundle: $name",
  async (failure) => {
    const directory = await createTestTempDirectory(
      "rea-bundle-capture-failure-",
    );
    const path = join(directory, "bundle.json");
    await writeFile(
      path,
      serializeEvidenceBundle(createEvidenceBundle([processEvidence()])),
    );
    const validator = vi
      .spyOn(processCaptureSchema, "safeParse")
      .mockImplementation(() => {
        throw failure;
      });
    onTestFinished(() => validator.mockRestore());

    await expect(
      compareEvidenceBundlesCommand({ leftPath: path, rightPath: path }),
    ).rejects.toBe(failure);
  },
);

it.each([
  new TypeError("comparison output invariant failed"),
  new RangeError("comparison computation failed"),
  new z.ZodError([
    { code: "custom", path: ["status"], message: "invalid generated result" },
  ]),
])(
  "keeps an internal comparison failure distinct from damaged Evidence: $name",
  async (failure) => {
    const directory = await createTestTempDirectory(
      "rea-bundle-compute-failure-",
    );
    const path = join(directory, "bundle.json");
    await writeFile(path, serializeEvidenceBundle(createEvidenceBundle([])));
    // Reach output validation through the actual command, reader, authentication
    // and comparison. This fault is generated output, not the caller's bundle.
    const output = vi
      .spyOn(bundleComparisonResultSchema, "parse")
      .mockImplementation(() => {
        throw failure;
      });
    onTestFinished(() => output.mockRestore());

    const originalExitCode = process.exitCode;
    onTestFinished(() => {
      process.exitCode = originalExitCode;
    });
    process.exitCode = 0;
    let stdout = "";
    let exitCode = 0;
    await createCli({}).serve(["compare", path, path, "--json"], {
      env: {},
      stdout: (chunk) => {
        stdout += chunk;
      },
      exit: (code) => {
        exitCode = code;
      },
    });
    expect(exitCode || Number(process.exitCode ?? 0)).toBe(1);
    expect(JSON.parse(stdout)).toEqual({
      code: "UNKNOWN",
      message: failure.message,
    });
    await expect(
      compareEvidenceBundlesCommand({ leftPath: path, rightPath: path }),
    ).rejects.toBe(failure);
  },
);
