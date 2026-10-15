import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it as test } from "vitest";

import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";
import { fakeKunaCalls, writeFakeKuna } from "./fakeKuna.js";

const it = test.skipIf(process.platform === "win32");

it.each([
  { populated: false, names: "main", reason: "No caller-built targets" },
  { populated: true, names: "typo", reason: "No caller-built targets" },
  {
    populated: true,
    names: "main,typo",
    reason: "Requested functions were not found",
  },
])(
  "rejects an unverified caller matrix: $names, populated=$populated",
  async ({ populated, names, reason }) => {
    const root = await createTestTempDirectory("rea-kuna-verifier-selection-");
    const kuna = await writeFakeKuna(root);
    const targets = join(root, "targets");
    await mkdir(targets);
    if (populated) {
      const flavor = join(targets, "linux");
      await mkdir(flavor);
      await writeFile(join(flavor, "program"), "not analyzed");
      await writeFile(join(flavor, "program.stripped"), "not analyzed");
    }
    // Only symbol discovery is simulated; no provider workflow should start.
    const nm = join(root, "nm");
    await writeFile(
      nm,
      `#!${process.execPath}\nprocess.stdout.write("00001000 T main\\n");\n`,
      {
        mode: 0o755,
      },
    );
    const result = spawnSync(
      process.execPath,
      [
        "scripts/verify-real-kuna.mjs",
        "--targets",
        targets,
        "--functions",
        names,
        "--compare-ghidra",
      ],
      {
        encoding: "utf8",
        timeout: 10_000,
        env: {
          PATH: process.env.PATH,
          HOME: root,
          REA_KUNA_COMMAND: kuna,
          REA_NM: nm,
          REA_CC: join(root, "compiler-must-not-run"),
          GHIDRA_INSTALL_DIR: join(root, "ghidra-must-not-run"),
        },
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(reason);
    expect(result.stderr).not.toContain("compiler-must-not-run");
    expect((await fakeKunaCalls(kuna)).map(({ argv }) => argv)).toEqual([
      ["--version"],
    ]);
  },
);
