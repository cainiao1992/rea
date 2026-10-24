import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";

import { buildManagedPeFixture } from "../../../src/dotnet/ManagedPe.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "attributes malformed managed comparison input to its selected argument and retains completed peer Evidence",
  async ({ cli }) => {
    const directory = await createTestTempDirectory(
      "rea-managed-malformed-cli-",
    );
    const good = join(directory, "good.dll");
    const bad = join(directory, "bad.dll");
    const bytes = buildManagedPeFixture();
    await writeFile(good, bytes);
    bytes.writeUInt16LE(0, bytes.readUInt32LE(0x3c) + 6);
    await writeFile(bad, bytes);

    const healthy = await cli.run({
      arguments: ["compare-managed-members", good, good, "--json"],
    });
    expect(healthy.exitCode, healthy.stderr).toBe(0);
    expect(healthy.json).toMatchObject({
      operation: "compare_managed_members",
      parameters: { left_path: good, right_path: good },
    });

    for (const field of ["leftPath", "rightPath"] as const) {
      const result = await cli.run({
        arguments: [
          "compare-managed-members",
          field === "leftPath" ? bad : good,
          field === "rightPath" ? bad : good,
          "--json",
        ],
      });
      expect(result.exitCode, result.stderr).toBe(1);
      expect(result.json).toMatchObject({
        code: "invalid_request",
        category: "invalid_input",
        retryable: false,
        details: {
          issues: [
            {
              path: [field],
              reason: "invalid_format",
              message: `Selected artifact ${bad}: PE section count must be positive`,
            },
          ],
        },
      });
      if (field === "rightPath")
        expect(result.json).toMatchObject({
          details: {
            partial_observation: {
              operation: "inspect_managed_members",
              subject: { local_path: good },
            },
          },
        });
      else
        expect(result.json).not.toHaveProperty("details.partial_observation");
    }

    const inspection = await cli.run({
      arguments: ["inspect-managed-members", bad, "--json"],
    });
    expect(inspection.exitCode, inspection.stderr).toBe(1);
    expect(inspection.json).toMatchObject({
      code: "invalid_request",
      category: "invalid_input",
      details: {
        issues: [
          {
            path: ["path"],
            reason: "invalid_format",
            message: `Selected artifact ${bad}: PE section count must be positive`,
          },
        ],
      },
    });
  },
);
