import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

import { scanAuthorizedArtifactInventory } from "../../../src/application/AuthorizedArtifactInventory.js";

const LIMITS = {
  maxEntries: 100,
  maxTotalBytes: 1024 * 1024,
  maxEntryBytes: 1024 * 1024,
  maxCompressionRatio: 100,
  maxDepth: 10,
  maxPathBytes: 1024,
} as const;

describe("authorized artifact inventory", () => {
  it("scans a local artifact without configured input roots", async () => {
    const root = await createTestTempDirectory("rea-artifact-roots-");
    const path = join(root, "artifact.js");
    await writeFile(path, "export const value = 1;\n");
    const inventory = await scanAuthorizedArtifactInventory(path, LIMITS);
    expect(inventory.manifest.root_format).toBe("javascript-bundle");
  });
});
