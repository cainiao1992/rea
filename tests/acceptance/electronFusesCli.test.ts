import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { expect } from "vitest";

import { toolContract } from "../../src/contracts/toolContracts.js";
import {
  OBSIDIAN_FUSE_BYTES,
  sentinelFreeMacho,
  thinFuseImage,
  universalFuseImage,
} from "../fixtures/electron/fuseImage.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

cliTest(
  "reads thin and universal Electron fuse wires through the public CLI",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-electron-fuses-cli-");
    const thin = thinFuseImage(OBSIDIAN_FUSE_BYTES);
    const universal = universalFuseImage();
    await writeFile(join(root, "thin"), thin.bytes);
    await writeFile(join(root, "universal"), universal.bytes);

    const thinResult = await cli.run({
      arguments: ["inspect-electron-fuses", "thin", "--json"],
      cwd: root,
    });
    expect(thinResult.exitCode, thinResult.stderr).toBe(0);
    const thinEvidence = toolContract(
      "inspect_electron_fuses",
    ).outputSchema.parse(thinResult.json);
    expect(thinEvidence.subject?.local_path).toBe(join(root, "thin"));
    expect(thinEvidence.subject?.digest.sha256).toBe(
      createHash("sha256").update(thin.bytes).digest("hex"),
    );
    expect(thinEvidence.subject?.architecture).toBe("arm64");
    expect(
      thinEvidence.normalized_result.slices[0]?.sentinels[0],
    ).toMatchObject({
      sentinel_offset: thin.sentinelOffset,
      wire_version: 1,
      declared_length: 8,
    });
    expect(
      thinEvidence.normalized_result.runtime_implications.find(
        (item) => item.subject === "node_cli_inspect_arguments",
      ),
    ).toMatchObject({ outcome: "not_honored", fuse_index: 3 });

    const universalResult = await cli.run({
      arguments: ["inspect-electron-fuses", join(root, "universal"), "--json"],
    });
    expect(universalResult.exitCode, universalResult.stderr).toBe(0);
    const universalEvidence = toolContract(
      "inspect_electron_fuses",
    ).outputSchema.parse(universalResult.json);
    expect(universalEvidence.normalized_result.artifact.format).toBe(
      "mach-o-universal",
    );
    expect(universalEvidence.subject?.architecture).toBeNull();
    expect(
      universalEvidence.normalized_result.slices.map((slice) => ({
        file_offset: slice.file_offset,
        sentinel_offset: slice.sentinels[0]?.sentinel_offset,
      })),
    ).toEqual([
      {
        file_offset: universal.left.fileOffset,
        sentinel_offset: universal.left.sentinelOffset,
      },
      {
        file_offset: universal.right.fileOffset,
        sentinel_offset: universal.right.sentinelOffset,
      },
    ]);
  },
);

cliTest(
  "reports a missing sentinel as unknown fuse state through the public CLI",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-electron-fuses-cli-empty-");
    const path = join(root, "empty");
    await writeFile(path, sentinelFreeMacho());
    const result = await cli.run({
      arguments: ["inspect-electron-fuses", path, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = toolContract("inspect_electron_fuses").outputSchema.parse(
      result.json,
    );
    expect(evidence.normalized_result.slices[0]?.sentinel_count).toBe(0);
    expect(evidence.normalized_result.runtime_implications).toEqual([]);
    expect(evidence.limitations.join(" ")).toContain(
      "unknown, not that every fuse is disabled",
    );
  },
);

cliTest(
  "resolves an Electron app bundle to its framework binary through the public CLI",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-electron-fuses-cli-app-");
    const image = thinFuseImage(OBSIDIAN_FUSE_BYTES);
    const app = join(root, "Fixture.app");
    const binary = join(
      app,
      "Contents",
      "Frameworks",
      "Electron Framework.framework",
      "Versions",
      "A",
      "Electron Framework",
    );
    await mkdir(join(binary, ".."), { recursive: true });
    await writeFile(binary, image.bytes);
    await symlink("A", join(binary, "..", "..", "Current"));
    const result = await cli.run({
      arguments: ["inspect-electron-fuses", app, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = toolContract("inspect_electron_fuses").outputSchema.parse(
      result.json,
    );
    expect(evidence.normalized_result.artifact).toMatchObject({
      selected_path: app,
      resolved_path: binary,
      format: "mach-o",
    });
    expect(evidence.subject?.local_path).toBe(binary);
  },
);

cliTest(
  "rejects an unrecognized container through the public CLI",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-electron-fuses-cli-text-");
    const path = join(root, "notes.txt");
    await writeFile(path, "This is not an executable container.");
    const result = await cli.run({
      arguments: ["inspect-electron-fuses", path, "--json"],
    });
    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({
      code: "unsupported_target",
      details: { operation: "inspect_electron_fuses", path },
    });
  },
);
