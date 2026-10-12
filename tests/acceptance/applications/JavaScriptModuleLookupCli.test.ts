import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { analyzeJavaScriptDirectory } from "../../support/cli/javascriptApplication.js";
import { writeFixtureFiles } from "../../support/javascriptApplicationFixture.js";

const execute = promisify(execFile);

const createModuleLookupFixture = async () => {
  const root = await createTestTempDirectory("rea-module-lookup-");
  await writeFixtureFiles(root, {
    "package.json": JSON.stringify({ name: "module-lookup-fixture" }),
    "esm/entry.mjs": [
      'import "./extensionless";',
      'import "./directory";',
      'import "./explicit.js";',
      'import "./exact.js";',
      'import fallback from "empty-main";',
      'import "nested-main";',
      'import "file-only";',
      'import "ancestor-empty";',
      'import "ancestor-blocked";',
      'import "ancestor-sub/parser";',
      "void fallback;",
    ].join("\n"),
    "esm/extensionless.js": "module.exports = 1;",
    "esm/directory/index.js": "module.exports = 2;",
    "esm/explicit.js.js": "module.exports = 3;",
    "esm/exact.js": "module.exports = 4;",
    "cjs/entry.cjs": [
      'require("./extensionless");',
      'require("./feature");',
      'require("./feature.cjs");',
      'require("./default-js");',
      'require("./default-json");',
      'require("./default-node");',
      'require("empty-main");',
      'require("nested-main");',
      'require("file-only");',
      'require("ancestor-empty");',
      'require("ancestor-blocked");',
      'require("ancestor-sub/parser");',
    ].join("\n"),
    "cjs/extensionless.cjs": "module.exports = 1;",
    "cjs/feature.cjs": "module.exports = 2;",
    "cjs/default-js.js": "module.exports = 3;",
    "cjs/default-json.json": JSON.stringify({ value: 4 }),
    // Inventory-only placeholder: never pass this path to Node's runtime.
    "cjs/default-node.node": "source-owned opaque native-module placeholder",
    "node_modules/empty-main/package.json": JSON.stringify({ main: "" }),
    "node_modules/empty-main/index.js": "module.exports = 42;",
    "node_modules/nested-main/package.json": JSON.stringify({ main: "sub" }),
    "node_modules/nested-main/sub/package.json": JSON.stringify({
      main: "other",
    }),
    "node_modules/nested-main/sub/other.js": "module.exports = 99;",
    "node_modules/file-only.js": "module.exports = 7;",
    "node_modules/ancestor-empty/index.js": "module.exports = 8;",
    "node_modules/ancestor-blocked/index.js": "module.exports = 9;",
    "node_modules/ancestor-sub/parser.js": "module.exports = 10;",
    "esm/runtime-control.mjs": [
      'const specifiers = ["./extensionless", "./directory", "./explicit.js", "./exact.js", "empty-main", "nested-main", "file-only", "ancestor-empty", "ancestor-blocked", "ancestor-sub/parser"];',
      "const results = [];",
      "for (const specifier of specifiers) {",
      "  try { await import(specifier); results.push({ specifier, ok: true }); }",
      "  catch (error) { results.push({ specifier, ok: false, code: error.code }); }",
      "}",
      "console.log(JSON.stringify(results));",
    ].join("\n"),
    "cjs/runtime-control.cjs": [
      'const specifiers = ["./extensionless", "./feature", "./feature.cjs", "./default-js", "./default-json", "empty-main", "nested-main", "file-only", "ancestor-empty", "ancestor-blocked", "ancestor-sub/parser"];',
      "const results = [];",
      "for (const specifier of specifiers) {",
      "  try { require(specifier); results.push({ specifier, ok: true }); }",
      "  catch (error) { results.push({ specifier, ok: false, code: error.code }); }",
      "}",
      "console.log(JSON.stringify(results));",
    ].join("\n"),
  });
  for (const directory of ["esm", "cjs"])
    await writeFixtureFiles(root, {
      [`${directory}/node_modules/ancestor-empty/package.json`]: JSON.stringify(
        { main: "" },
      ),
      [`${directory}/node_modules/ancestor-blocked/package.json`]:
        JSON.stringify({ main: "missing" }),
      [`${directory}/node_modules/ancestor-sub/package.json`]: "{}",
    });
  return root;
};

cliTest.for(["CLI", "stdio MCP"] as const)(
  "matches Node module lookup for ESM and CommonJS through %s",
  async (surface, { cli }) => {
    const root = await createModuleLookupFixture();
    const [esmControl, cjsControl] = await Promise.all([
      execute(process.execPath, ["esm/runtime-control.mjs"], {
        cwd: root,
        timeout: 5_000,
      }),
      execute(process.execPath, ["cjs/runtime-control.cjs"], {
        cwd: root,
        timeout: 5_000,
      }),
    ]);
    const esmResults = JSON.parse(esmControl.stdout) as Array<{
      readonly specifier: string;
      readonly ok: boolean;
      readonly code?: string;
    }>;
    const cjsResults = JSON.parse(cjsControl.stdout) as Array<{
      readonly specifier: string;
      readonly ok: boolean;
      readonly code?: string;
    }>;
    expect(esmResults).toEqual([
      {
        specifier: "./extensionless",
        ok: false,
        code: "ERR_MODULE_NOT_FOUND",
      },
      {
        specifier: "./directory",
        ok: false,
        code: "ERR_UNSUPPORTED_DIR_IMPORT",
      },
      {
        specifier: "./explicit.js",
        ok: false,
        code: "ERR_MODULE_NOT_FOUND",
      },
      { specifier: "./exact.js", ok: true },
      { specifier: "empty-main", ok: true },
      { specifier: "nested-main", ok: false, code: "ERR_MODULE_NOT_FOUND" },
      { specifier: "file-only", ok: false, code: "ERR_MODULE_NOT_FOUND" },
      { specifier: "ancestor-empty", ok: false, code: "ERR_MODULE_NOT_FOUND" },
      {
        specifier: "ancestor-blocked",
        ok: false,
        code: "ERR_MODULE_NOT_FOUND",
      },
      {
        specifier: "ancestor-sub/parser",
        ok: false,
        code: "ERR_MODULE_NOT_FOUND",
      },
    ]);
    expect(cjsResults).toEqual([
      {
        specifier: "./extensionless",
        ok: false,
        code: "MODULE_NOT_FOUND",
      },
      {
        specifier: "./feature",
        ok: false,
        code: "MODULE_NOT_FOUND",
      },
      { specifier: "./feature.cjs", ok: true },
      { specifier: "./default-js", ok: true },
      { specifier: "./default-json", ok: true },
      { specifier: "empty-main", ok: true },
      { specifier: "nested-main", ok: false, code: "MODULE_NOT_FOUND" },
      { specifier: "file-only", ok: true },
      { specifier: "ancestor-empty", ok: true },
      { specifier: "ancestor-blocked", ok: false, code: "MODULE_NOT_FOUND" },
      { specifier: "ancestor-sub/parser", ok: true },
    ]);

    const { graph } = await analyzeJavaScriptDirectory(surface, cli, root);
    const expectations = [
      ["import", "./extensionless", null, "not-found"],
      ["import", "./directory", null, "not-found"],
      ["import", "./explicit.js", null, "not-found"],
      ["import", "./exact.js", "esm/exact.js", "resolved"],
      ["import", "empty-main", "node_modules/empty-main/index.js", "resolved"],
      ["import", "nested-main", null, "not-found"],
      ["import", "file-only", null, "external"],
      ["import", "ancestor-empty", null, "not-found"],
      ["import", "ancestor-blocked", null, "not-found"],
      ["import", "ancestor-sub/parser", null, "not-found"],
      ["require", "./extensionless", null, "not-found"],
      ["require", "./feature", null, "not-found"],
      ["require", "./feature.cjs", "cjs/feature.cjs", "resolved"],
      ["require", "./default-js", "cjs/default-js.js", "resolved"],
      ["require", "./default-json", "cjs/default-json.json", "resolved"],
      ["require", "./default-node", "cjs/default-node.node", "resolved"],
      ["require", "empty-main", "node_modules/empty-main/index.js", "resolved"],
      ["require", "nested-main", null, "not-found"],
      ["require", "file-only", "node_modules/file-only.js", "resolved"],
      [
        "require",
        "ancestor-empty",
        "node_modules/ancestor-empty/index.js",
        "resolved",
      ],
      ["require", "ancestor-blocked", null, "not-found"],
      [
        "require",
        "ancestor-sub/parser",
        "node_modules/ancestor-sub/parser.js",
        "resolved",
      ],
    ] as const;

    for (const [kind, specifier, resolvedPath, status] of expectations)
      expect(graph.edges).toContainEqual(
        expect.objectContaining({
          relation: "imports",
          properties: expect.objectContaining({
            module_link_kind: kind,
            specifier,
            resolved_path: resolvedPath,
            resolution_status: status,
          }),
        }),
      );
  },
);
