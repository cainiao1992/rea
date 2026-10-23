import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { nativeExportsSchema } from "../../../src/domain/native/nativeExports.js";
import { elfExportImage } from "../../fixtures/binaryDiagnostics/nativeExports.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const contract = toolContract("inspect_native_exports");

cliTest(
  "reports defined ELF symbols named by the version-requirement table",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-elf-version-requirements-");
    const path = join(root, "copy-relocated-exports");
    const bytes = elfExportImage({
      symbols: [{ name: "stdout", type: 1, value: 0x28268n, version: 3 }],
      versionRequirements: [{ index: 3, name: "GLIBC_2.2.5" }],
    });
    await writeFile(path, bytes);

    const result = await cli.run({
      arguments: ["inspect-native-exports", path, "--json"],
    });
    expect(result.exitCode).toBe(0);
    const evidence = contract.outputSchema.parse(result.json);
    expect(nativeExportsSchema.parse(evidence.normalized_result)).toMatchObject(
      {
        format: "elf",
        coverage: { status: "complete", exports: 1 },
        issues: [],
        exports: [
          {
            name: "stdout",
            value: "0x28268",
            version: { index: 3, name: "GLIBC_2.2.5", hidden: false },
          },
        ],
      },
    );
  },
  30_000,
);
