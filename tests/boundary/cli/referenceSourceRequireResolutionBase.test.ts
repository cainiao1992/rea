import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";

import { historicalSourceGraphSchema } from "../../../src/domain/referenceSourceGraph.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "preserves unknown CommonJS resolution when Node is given another base",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-reference-require-base-");
    const config = await createTestTempDirectory(
      "rea-reference-require-base-config-",
    );
    await mkdir(join(root, "sub"), { recursive: true });
    await Promise.all([
      writeFile(
        join(root, "main.mjs"),
        [
          'import { createRequire } from "node:module";',
          'const custom = createRequire(new URL("./sub/entry.cjs", import.meta.url));',
          'custom("./dep.cjs");',
          "const local = createRequire(import.meta.url);",
          'local("./dep.cjs");',
        ].join("\n"),
      ),
      writeFile(join(root, "dep.cjs"), "module.exports = 'root';\n"),
      writeFile(join(root, "sub", "dep.cjs"), "module.exports = 'sub';\n"),
    ]);

    const result = await cli.run({
      arguments: ["import-reference-source", root, "--json"],
      environment: {
        HOME: config,
        XDG_CONFIG_HOME: config,
        XDG_CACHE_HOME: config,
      },
    });
    expect(result.exitCode, result.stderr + JSON.stringify(result.json)).toBe(
      0,
    );
    const graph = historicalSourceGraphSchema.parse(result.json);
    expect(graph.relationships).toEqual(
      expect.arrayContaining([
        {
          from_path: "main.mjs",
          to: "./dep.cjs",
          kind: "requires",
          resolution: "unknown",
          parse_state: "partial",
        },
        {
          from_path: "main.mjs",
          to: "dep.cjs",
          kind: "requires",
          resolution: "internal",
          parse_state: "parsed",
        },
      ]),
    );
  },
);

cliTest(
  "honors supported require.resolve search options and leaves alternate paths unknown",
  async ({ cli }) => {
    const root = await createTestTempDirectory(
      "rea-reference-require-resolve-paths-",
    );
    const config = await createTestTempDirectory(
      "rea-reference-require-resolve-paths-config-",
    );
    await mkdir(join(root, "sub"), { recursive: true });
    await Promise.all([
      writeFile(
        join(root, "main.cjs"),
        [
          'require.resolve("./dep.cjs");',
          'require.resolve("./dep.cjs", { paths: [__dirname] });',
          'require.resolve("./dep.cjs", { paths: [__dirname + "/sub"] });',
          'require.resolve("./dep.cjs", { paths: [] });',
        ].join("\n"),
      ),
      writeFile(join(root, "dep.cjs"), "module.exports = 'root';\n"),
      writeFile(join(root, "sub", "dep.cjs"), "module.exports = 'sub';\n"),
    ]);

    const result = await cli.run({
      arguments: ["import-reference-source", root, "--json"],
      environment: {
        HOME: config,
        XDG_CONFIG_HOME: config,
        XDG_CACHE_HOME: config,
      },
    });
    expect(result.exitCode, result.stderr + JSON.stringify(result.json)).toBe(
      0,
    );
    const graph = historicalSourceGraphSchema.parse(result.json);
    const relationships = graph.relationships.filter(
      ({ from_path, kind }) => from_path === "main.cjs" && kind === "requires",
    );
    expect(relationships).toEqual(
      expect.arrayContaining([
        {
          from_path: "main.cjs",
          to: "dep.cjs",
          kind: "requires",
          resolution: "internal",
          parse_state: "parsed",
        },
        {
          from_path: "main.cjs",
          to: "./dep.cjs",
          kind: "requires",
          resolution: "unknown",
          parse_state: "partial",
        },
      ]),
    );
    expect(relationships).toHaveLength(2);
  },
);
