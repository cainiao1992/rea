import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../src/contracts/toolContracts.js";
import { erlangBeamFixture } from "../../src/erlang/Beam.fixture.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

const oneAtomBeam = (paddingByte: number): Buffer => {
  const bytes = Buffer.alloc(28);
  bytes.write("FOR1", 0, "latin1");
  bytes.writeUInt32BE(20, 4);
  bytes.write("BEAM", 8, "latin1");
  bytes.write("AtU8", 12, "latin1");
  bytes.writeUInt32BE(6, 16);
  bytes.writeUInt32BE(1, 20);
  bytes[24] = 1;
  bytes[25] = "m".charCodeAt(0);
  bytes[26] = paddingByte;
  bytes[27] = paddingByte === 0 ? 0 : 1;
  return bytes;
};

cliTest("reports BEAM exports through the public CLI", async ({ cli }) => {
  const root = await createTestTempDirectory("rea-beam-cli-");
  const path = join(root, "app.beam");
  await writeFile(path, erlangBeamFixture("cli_mod"));
  const result = await cli.run({
    arguments: ["inspect-erlang-beam", path, "--json"],
  });
  expect(result.exitCode, result.stderr).toBe(0);
  const evidence = toolContract("inspect_erlang_beam").outputSchema.parse(
    result.json,
  );
  expect(evidence.normalized_result.module).toBe("cli_mod");
  expect(
    evidence.normalized_result.exports?.some(
      (entry) => entry.function === "start" && entry.arity === 0,
    ),
  ).toBe(true);
});

cliTest(
  "inspects BEAM chunks with nonzero alignment padding and preserves payload identity",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-beam-padding-");
    const cleanPath = join(root, "padding-zero.beam");
    const paddedPath = join(root, "padding-nonzero.beam");
    await writeFile(cleanPath, oneAtomBeam(0));
    await writeFile(paddedPath, oneAtomBeam(0x7f));

    const inspect = async (path: string) => {
      const result = await cli.run({
        arguments: ["inspect-erlang-beam", path, "--json"],
      });
      expect(result.exitCode, result.stderr).toBe(0);
      return toolContract("inspect_erlang_beam").outputSchema.parse(
        result.json,
      );
    };
    const clean = await inspect(cleanPath);
    const padded = await inspect(paddedPath);
    expect(padded.normalized_result.module).toBe("m");
    expect(padded.normalized_result.chunks).toEqual(
      clean.normalized_result.chunks,
    );
    expect(padded.normalized_result.artifact.bytes).toBe(
      clean.normalized_result.artifact.bytes,
    );
    expect(padded.normalized_result.artifact.sha256).not.toBe(
      clean.normalized_result.artifact.sha256,
    );
  },
);

cliTest(
  "rejects a BEAM chunk whose required alignment bytes are truncated",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-beam-padding-short-");
    const path = join(root, "padding-truncated.beam");
    const bytes = oneAtomBeam(0x7f).subarray(0, 27);
    bytes.writeUInt32BE(19, 4);
    await writeFile(path, bytes);
    const result = await cli.run({
      arguments: ["inspect-erlang-beam", path, "--json"],
    });
    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({
      code: "invalid_request",
      details: { operation: "inspect_erlang_beam" },
    });
  },
);

cliTest(
  "resolves a relative BEAM path against the working directory",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-beam-cli-rel-");
    await writeFile(join(root, "app.beam"), erlangBeamFixture());
    const result = await cli.run({
      arguments: ["inspect-erlang-beam", "app.beam", "--json"],
      cwd: root,
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = toolContract("inspect_erlang_beam").outputSchema.parse(
      result.json,
    );
    expect(evidence.subject?.local_path).toBe(join(root, "app.beam"));
  },
);

cliTest("rejects an empty BEAM path before reading", async ({ cli }) => {
  const root = await createTestTempDirectory("rea-beam-cli-path-");
  const result = await cli.run({
    arguments: ["inspect-erlang-beam", "", "--json"],
    cwd: root,
  });
  expect(result.exitCode, result.stderr).not.toBe(0);
  expect(result.stdout).not.toContain("sha256");
});

cliTest("reports a truncated BEAM as invalid input", async ({ cli }) => {
  const root = await createTestTempDirectory("rea-beam-cli-bad-");
  const path = join(root, "broken.beam");
  await writeFile(path, Buffer.from("FOR1"));
  const result = await cli.run({
    arguments: ["inspect-erlang-beam", path, "--json"],
  });
  expect(result.exitCode).toBe(1);
  expect(result.json).toMatchObject({
    code: "invalid_request",
    details: { operation: "inspect_erlang_beam" },
  });
});
