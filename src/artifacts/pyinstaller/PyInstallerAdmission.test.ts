import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { withOwnedRegularFile } from "../../filesystem/OwnedRegularFile.js";
import { ArtifactEmbeddedFormatProbes } from "../ArtifactEmbeddedFormatProbes.js";
import { ArtifactResourceScope } from "../ArtifactResourceScope.js";
import { inventoryArtifact } from "../inventory/ArtifactInventory.js";
import { PyInstallerArtifactReader } from "../PyInstallerArtifactReader.js";
import { cArchiveExecutable } from "./CArchive.fixture.js";
import * as layout from "./CArchiveLayout.js";

const fixture = () =>
  cArchiveExecutable({
    layout: "2.1",
    pythonVersion: 314,
    pythonLibrary: "libpython3.14.so",
    members: [
      {
        name: "payload",
        typeCode: "x",
        payload: Buffer.from("fixture"),
        compress: false,
      },
    ],
  });

it("inventories members using the cookie discovered by root classification", async () => {
  const root = await createTestTempDirectory(
    "rea-pyinstaller-cookie-inventory-",
  );
  const path = join(root, "app");
  await writeFile(path, fixture());
  const locate = vi.spyOn(layout, "findPyInstallerCookie");
  const resourceScope = new ArtifactResourceScope();
  try {
    const result = await inventoryArtifact(path, {
      environment: {},
      resourceScope,
    });
    expect(result.manifest.root_format).toBe("pyinstaller");
    expect(
      result.occurrences.some(
        (entry) =>
          entry.logical_path === "payload" && entry.hash_status === "verified",
      ),
    ).toBe(true);
    expect(locate).toHaveBeenCalledTimes(1);
  } finally {
    await resourceScope.close();
    locate.mockRestore();
  }
});

it("rejects changed source before consuming an admitted cookie and leaves the borrowed descriptor open", async () => {
  const root = await createTestTempDirectory("rea-pyinstaller-cookie-change-");
  const path = join(root, "app");
  await writeFile(path, fixture());
  await withOwnedRegularFile(path, {}, async (source) => {
    const cookie = await new ArtifactEmbeddedFormatProbes(
      path,
      source,
    ).pyInstaller();
    if (cookie === undefined) throw new Error("Fixture cookie was not found");
    const reader = new PyInstallerArtifactReader(path, {
      kind: "pyinstaller",
      source,
      cookie,
    });
    await appendFile(path, "changed");
    try {
      await expect(
        (async () => {
          for await (const entry of reader.entries())
            throw new Error(`Changed source exposed member ${entry.path}`);
        })(),
      ).rejects.toMatchObject({ reason: "integrity" });
    } finally {
      await reader.close();
    }
    await expect(source.handle.stat()).resolves.toMatchObject({
      size: fixture().length + 7,
    });
  });
});

it("retains completed cookie facts across unchanged admissions and honors cached cancellation", async () => {
  const root = await createTestTempDirectory("rea-pyinstaller-cookie-cache-");
  const path = join(root, "app");
  await writeFile(path, fixture());
  const locate = vi.spyOn(layout, "findPyInstallerCookie");
  try {
    await withOwnedRegularFile(path, {}, async (source) => {
      const controller = new AbortController();
      const probes = new ArtifactEmbeddedFormatProbes(
        path,
        source,
        controller.signal,
      );
      const cookie = await probes.pyInstaller();
      expect(cookie).toMatchObject({ layout: "2.1", pythonVersion: 314 });
      const resumed = new ArtifactEmbeddedFormatProbes(
        path,
        source,
        controller.signal,
        probes.completedFacts(),
      );
      await expect(resumed.pyInstaller()).resolves.toBe(cookie);
      controller.abort(new Error("cancel cached cookie"));
      await expect(resumed.pyInstaller()).rejects.toMatchObject({
        reason: "cancelled",
      });
      expect(locate).toHaveBeenCalledTimes(1);
    });
  } finally {
    locate.mockRestore();
  }
});
