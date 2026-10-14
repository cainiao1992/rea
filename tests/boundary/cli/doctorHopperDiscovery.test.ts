import { access, chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest.skipIf(process.platform === "win32")(
  "preserves a configured Hopper launcher through public CLI doctor without launching it",
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
      },
      timeoutMs: 20_000,
    });

    expect(result.json).toMatchObject({
      hopperPath: launcher,
      checks: expect.arrayContaining([
        expect.objectContaining({
          name: "hopper",
          ok: true,
          detail: launcher,
        }),
      ]),
    });
    await expect(access(launchMarker)).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);
