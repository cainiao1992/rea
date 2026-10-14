import { access, chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest.skipIf(!["darwin", "linux"].includes(process.platform))(
  "retains a configured Hopper path in host diagnostics without launching it",
  async ({ cli }) => {
    const home = await createTestTempDirectory("rea-doctor-hopper-home-");
    const launcher = `${home}/bin/../bin/hopper`;
    const launchMarker = join(home, "hopper-was-launched");
    await mkdir(join(home, "bin"), { recursive: true });
    await writeFile(
      launcher,
      '#!/bin/sh\nprintf launched > "$REA_HOPPER_TEST_MARKER"\nexit 99\n',
    );
    await chmod(launcher, 0o700);

    const result = await cli.run({
      arguments: ["doctor", "--provider", "hopper", "--json"],
      cwd: home,
      environment: {
        HOME: home,
        USERPROFILE: home,
        HOPPER_LAUNCHER_PATH: launcher,
        REA_HOPPER_TEST_MARKER: launchMarker,
        GHIDRA_INSTALL_DIR: join(home, "missing-ghidra"),
      },
      timeoutMs: 20_000,
    });

    const executableOnHost = process.platform === "darwin";
    expect(result.signal).toBeNull();
    expect(result.exitCode).toBe(executableOnHost ? 0 : 1);
    expect(result.json).toMatchObject({
      healthy: executableOnHost,
      environment_healthy: false,
      ...(executableOnHost ? { hopperPath: launcher } : {}),
      checks: expect.arrayContaining([
        expect.objectContaining({
          name: "hopper",
          ok: executableOnHost,
          detail: launcher,
          classification: executableOnHost ? "healthy" : "config_drift",
          ...(executableOnHost
            ? {}
            : { remediation: expect.stringContaining("HOPPER_LAUNCHER_PATH") }),
        }),
      ]),
    });
    if (!executableOnHost) expect(result.json).not.toHaveProperty("hopperPath");
    await expect(access(launchMarker)).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);
