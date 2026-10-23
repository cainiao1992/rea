import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { nativeExportsSchema } from "../../../src/domain/native/nativeExports.js";
import { peExportImage } from "../../fixtures/binaryDiagnostics/nativeExports.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "reports the last PE ordinal when an unused EAT slot follows it",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-pe-export-last-ordinal-");
    const path = join(root, "exports.dll");
    await writeFile(
      path,
      peExportImage({
        ordinalBase: 0xffff,
        functions: [{ rva: 0x1300 }, null],
        names: [{ name: "Kept", index: 0 }],
      }),
    );

    const result = await cli.run({
      arguments: ["inspect-native-exports", path, "--json"],
    });

    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = toolContract("inspect_native_exports").outputSchema.parse(
      result.json,
    );
    expect(nativeExportsSchema.parse(evidence.normalized_result)).toMatchObject(
      {
        format: "pe",
        coverage: { status: "complete", examined_entries: 2, exports: 1 },
        issues: [],
        exports: [
          {
            name: "Kept",
            ordinal: 0xffff,
            address: "0x180001300",
            forwarder: null,
          },
        ],
      },
    );
  },
  30_000,
);
