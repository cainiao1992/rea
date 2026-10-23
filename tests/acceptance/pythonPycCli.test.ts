import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../src/contracts/toolContracts.js";
import {
  marshalCode,
  pythonPycFixture,
  pythonPycHeader,
} from "../../src/python/PythonPyc.fixture.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

cliTest(
  "reports nested CPython code objects through the public CLI",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-python-pyc-cli-");
    const path = join(root, "sample.pyc");
    await writeFile(path, pythonPycFixture("py311", { nested: true }));
    const result = await cli.run({
      arguments: ["inspect-python-pyc", path, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = toolContract("inspect_python_pyc").outputSchema.parse(
      result.json,
    );
    expect(evidence.normalized_result.header.python_version).toBe("3.12");
    expect(evidence.normalized_result.code_objects[1]?.name).toBe("inner");
  },
);

cliTest(
  "preserves negative CPython first line numbers through the public CLI",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-python-pyc-lines-");
    const path = join(root, "sample.pyc");
    const nested = marshalCode("py311", {
      name: "inner",
      firstlineno: -7,
    });
    const bytes = Buffer.concat([
      pythonPycHeader(3531),
      marshalCode("py311", {
        firstlineno: -1,
        consts: [nested],
      }),
    ]);
    await writeFile(path, bytes);
    const result = await cli.run({
      arguments: ["inspect-python-pyc", path, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = toolContract("inspect_python_pyc").outputSchema.parse(
      result.json,
    );
    expect(evidence.normalized_result.code_objects[0]?.firstlineno).toBe(-1);
    expect(evidence.normalized_result.code_objects[0]?.consts).toContainEqual({
      kind: "code",
      name: "inner",
      firstlineno: -7,
    });
  },
);

cliTest(
  "counts code keys using the selected CPython equality rules",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-python-pyc-equality-");
    const cases = [
      { magic: 3413, layout: "py38" as const, lengths: [1, 1] },
      { magic: 3439, layout: "py38" as const, lengths: [1, 1] },
      { magic: 3531, layout: "py311" as const, lengths: [2, 2] },
    ];
    for (const [index, testCase] of cases.entries()) {
      const code = (linetable: Buffer) =>
        marshalCode(testCase.layout, {
          name: "f",
          filename: "fixture.py",
          firstlineno: 1,
          linetable,
        });
      const frozenSet = Buffer.concat([
        Buffer.from([0x3e]),
        Buffer.from([2, 0, 0, 0]),
        code(Buffer.from([2, 1])),
        code(Buffer.from([2, 2])),
      ]);
      const dict = Buffer.concat([
        Buffer.from([0x7b]),
        code(Buffer.from([2, 1])),
        Buffer.from([0x4e]),
        code(Buffer.from([2, 2])),
        Buffer.from([0x54, 0x30]),
      ]);
      const path = join(root, `case-${index}.pyc`);
      await writeFile(
        path,
        Buffer.concat([
          pythonPycHeader(testCase.magic),
          marshalCode(testCase.layout, { consts: [frozenSet, dict] }),
        ]),
      );
      const result = await cli.run({
        arguments: ["inspect-python-pyc", path, "--json"],
      });
      expect(result.exitCode, result.stderr).toBe(0);
      const evidence = toolContract("inspect_python_pyc").outputSchema.parse(
        result.json,
      );
      expect(
        evidence.normalized_result.code_objects[0]?.consts.map((value) =>
          value.kind === "frozenset" || value.kind === "dict"
            ? value.length
            : null,
        ),
      ).toEqual(testCase.lengths);
    }
  },
);

cliTest(
  "resolves a relative pyc path against the working directory",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-python-pyc-cli-rel-");
    await writeFile(join(root, "sample.pyc"), pythonPycFixture("py37"));
    const result = await cli.run({
      arguments: ["inspect-python-pyc", "sample.pyc", "--json"],
      cwd: root,
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = toolContract("inspect_python_pyc").outputSchema.parse(
      result.json,
    );
    expect(evidence.normalized_result.header.python_version).toBe("3.7");
    expect(evidence.subject?.local_path).toBe(join(root, "sample.pyc"));
  },
);

cliTest.skipIf(process.platform === "win32")(
  "reads the file the symlink path names, not its lexical sibling",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-python-pyc-cli-link-");
    const target = join(root, "target");
    await mkdir(join(target, "child"), { recursive: true });
    await writeFile(join(target, "sample.pyc"), pythonPycFixture("py37"));
    await writeFile(join(root, "sample.pyc"), pythonPycFixture("py311"));
    await symlink(join(target, "child"), join(root, "link"));
    const result = await cli.run({
      arguments: ["inspect-python-pyc", "link/../sample.pyc", "--json"],
      cwd: root,
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = toolContract("inspect_python_pyc").outputSchema.parse(
      result.json,
    );
    expect(evidence.normalized_result.header.python_version).toBe("3.7");
    expect(evidence.subject?.local_path).toBe(`${root}/link/../sample.pyc`);
  },
);

cliTest("reports a truncated pyc as invalid input", async ({ cli }) => {
  const root = await createTestTempDirectory("rea-python-pyc-cli-bad-");
  const path = join(root, "broken.pyc");
  await writeFile(path, Buffer.from("not a pyc"));
  const result = await cli.run({
    arguments: ["inspect-python-pyc", path, "--json"],
  });
  expect(result.exitCode).toBe(1);
  expect(result.json).toMatchObject({
    code: "invalid_request",
    details: { operation: "inspect_python_pyc" },
  });
});
