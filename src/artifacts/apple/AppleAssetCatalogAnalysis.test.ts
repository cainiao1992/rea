import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import {
  analyzeAppleAssetCatalogs,
  collectInterfaceBuilderResourceKeys,
} from "./AppleAssetCatalogAnalysis.js";

describe("Apple asset catalog application workflow", () => {
  it("joins only explicit resource-key fields with archive provenance", () => {
    expect(
      collectInterfaceBuilderResourceKeys([
        {
          id: "ib:Main.nib:object:2",
          kind: "resource",
          name: "Decorative image",
          attributes: {
            imageName: "Toolbar",
            title: "not-an-asset-key",
            image: 42,
          },
          evidence: [
            {
              artifact_path: "Contents/Resources/Main.nib",
              artifact_sha256: "d".repeat(64),
            },
          ],
        },
        {
          id: "ib:Main.nib:object:3",
          kind: "control",
          name: "Toolbar",
          attributes: { title: "not-an-asset-key" },
          evidence: [],
        },
      ]),
    ).toEqual([
      {
        sourceNodeId: "ib:Main.nib:object:2",
        sourcePath: "Contents/Resources/Main.nib",
        sourceArchiveSha256: "d".repeat(64),
        field: "imageName",
        key: "Toolbar",
      },
    ]);
  });

  it("reports an app without compiled catalogs as an empty observed inventory", async () => {
    const bundle = await createTestTempDirectory("rea-asset-catalog-absent-");
    await mkdir(join(bundle, "Contents", "Resources"), { recursive: true });
    await writeFile(join(bundle, "Contents", "Resources", "icon.icns"), "");
    const result = await analyzeAppleAssetCatalogs({
      bundlePath: bundle,
      targetSha256: "a".repeat(64),
      runAssetUtil: () => {
        throw new Error("assetutil must not run without a catalog");
      },
    });
    expect(result).toMatchObject({
      catalogs: [],
      total_records: 0,
      records: [],
      resource_key_matches: [],
      next_offset: null,
      truncated: false,
    });
    expect(result.limitations).toContain(
      "No compiled Assets.car catalog was found in the app bundle; any resource keys are reported as unmatched.",
    );
  });
});
