import { join } from "node:path";

import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import {
  analyzeJavaScriptDirectory,
  runNodeJsonControl,
} from "../../support/cli/javascriptApplication.js";
import { writeFixtureFiles } from "../../support/javascriptApplicationFixture.js";

cliTest.each(["CLI", "stdio MCP"] as const)(
  "preserves module classification and explicit source identities through %s",
  async (surface, { cli }) => {
    const root = await createTestTempDirectory("rea-module-owner-semantics-");
    const valid = {
      "legacy/x%2Ey.js": "node_modules/legacy/x.y.js",
      "mapped/encoded": "node_modules/mapped/x.y.js",
      "mapped/double": "node_modules/mapped/x%2Ey.js",
      "#encoded": "local.file.mjs",
      "./dep.mjs ": "dep.mjs",
      "./de\np.mjs": "dep.mjs",
    };
    const invalid = [" ./dep.mjs", "\n./dep.mjs", "\t./dep.mjs", ".\n/dep.mjs"];
    await writeFixtureFiles(root, {
      "package.json": JSON.stringify({
        type: "module",
        imports: { "#encoded": "./local%2Efile.mjs" },
      }),
      "main.mjs": [
        ...Object.keys(valid),
        ...invalid,
        "mapped/missing",
        "mapped/invalid",
        "./dep.d.ts",
        "./cfg.d.mts",
        "./legacy.d.cts",
      ]
        .map((specifier) => `import ${JSON.stringify(specifier)};`)
        .join("\n"),
      "main.cjs": [
        "./dep.d.ts",
        "./cfg.d.mts",
        "./legacy.d.cts",
        "mapped/encoded",
        "mapped/double",
      ]
        .map((specifier) => `require(${JSON.stringify(specifier)});`)
        .join("\n"),
      "fallback.cts": 'require("./only.js");',
      "dep.d.ts": "export declare const value: number;",
      "cfg.d.mts": "export declare const value: number;",
      "legacy.d.cts": "export declare const value: number;",
      "only.d.ts": "export declare const value: number;",
      "dep.mjs": 'throw new Error("must never load");',
      "local.file.mjs": 'throw new Error("must never load");',
      "node_modules/legacy/package.json": '{"type":"module"}',
      "node_modules/legacy/x.y.js": 'throw new Error("must never load");',
      "node_modules/mapped/package.json": JSON.stringify({
        type: "module",
        exports: {
          "./encoded": "./x%2Ey.js",
          "./double": "./x%252Ey.js",
          "./missing": ["./absent%2Efile.js", "./x.y.js"],
          "./invalid": "./%2e%2e/escape.js",
        },
      }),
      "node_modules/mapped/x.y.js": 'throw new Error("must never load");',
      "node_modules/mapped/x%2Ey.js": 'throw new Error("must never load");',
      "oracle.mjs": `import {fileURLToPath} from "node:url"; import {relative} from "node:path"; const valid = ${JSON.stringify(Object.keys(valid))}; const invalid = ${JSON.stringify(invalid)}; console.log(JSON.stringify({ valid: valid.map(request => relative(process.cwd(), fileURLToPath(import.meta.resolve(request)))), invalid: invalid.map(request => { try { import.meta.resolve(request); return false; } catch { return true; } }) }));`,
    });
    expect(await runNodeJsonControl(root, join(root, "oracle.mjs"))).toEqual({
      valid: Object.values(valid),
      invalid: invalid.map(() => true),
    });
    const result = await analyzeJavaScriptDirectory(surface, cli, root);
    expect(result.statistics.parse_failures).toBe(0);
    const edges = (specifier: string) =>
      result.graph.edges.filter(
        (edge) =>
          edge.relation === "imports" &&
          edge.properties.specifier === specifier,
      );
    for (const [specifier, target] of Object.entries(valid)) {
      const matches = edges(specifier);
      expect(matches.length, specifier).toBeGreaterThan(0);
      for (const edge of matches)
        expect(edge.properties).toMatchObject({
          resolution_status: "resolved",
          resolved_path: target,
        });
    }
    for (const specifier of invalid) {
      const matches = edges(specifier);
      expect(matches.length, specifier).toBeGreaterThan(0);
      for (const edge of matches)
        expect(edge.properties.resolved_path).toBeNull();
    }
    for (const suffix of ["dep.d.ts", "cfg.d.mts", "legacy.d.cts"]) {
      const matches = edges(`./${suffix}`);
      expect(matches.length, suffix).toBeGreaterThan(0);
      for (const edge of matches)
        expect(edge.properties).toMatchObject({
          resolution_status: "resolved",
          resolved_path: suffix,
        });
    }
    for (const [specifier, status] of [
      ["./only.js", "unavailable"],
      ["mapped/missing", "not-found"],
      ["mapped/invalid", "rejected"],
    ] as const) {
      const matches = edges(specifier);
      expect(matches.length, specifier).toBeGreaterThan(0);
      for (const edge of matches)
        expect(edge.properties).toMatchObject({
          resolution_status: status,
          resolved_path: null,
        });
    }
  },
);
