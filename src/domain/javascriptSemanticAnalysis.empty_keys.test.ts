import { expect, it } from "vitest";
import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";

it.each([
  "const routes = {'': 'HOME'}; const root = routes[''];",
  "const routes = {['']: 'HOME'}; const root = routes[''];",
  "const routes = {'': 'HOME'}; const {'': root} = routes;",
  "const routes = {'': 'HOME'}; const {['']: root} = routes;",
  "const routes = {home: 'HOME'}; const root = routes.home;",
])("preserves exact string keys in %s", (source) => {
  const ir = analyzeJavaScriptSemantics(source);
  expect(ir.bindings.find(({ name }) => name === "root")?.value).toEqual({
    status: "literal",
    value: "HOME",
  });
  expect(
    ir.frontiers.filter(({ kind }) => kind === "dynamic-property"),
  ).toEqual([]);
});

it("keeps a computed identifier key unresolved", () => {
  const ir = analyzeJavaScriptSemantics(
    "const routes = {'': 'HOME'}; const root = routes[key];",
  );
  expect(ir.bindings.find(({ name }) => name === "root")?.value.status).toBe(
    "unknown",
  );
  expect(ir.frontiers).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: "dynamic-property" }),
    ]),
  );
});

it("retains exact empty method names and environment keys", () => {
  const ir = analyzeJavaScriptSemantics(`
    const target = { ['']() { return 42; } };
    class Holder { ""() { return 2; } }
    const empty = process.env[''];
    const dynamic = process.env[key];
  `);
  expect(
    ir.callables
      .filter(({ kind }) => kind === "method")
      .map(({ name }) => name),
  ).toEqual(["", ""]);
  expect(
    ir.configurationOperations.map(({ kind, key, resolution }) => ({
      kind,
      key,
      resolution,
    })),
  ).toEqual([
    { kind: "environment", key: "", resolution: "complete" },
    { kind: "environment", key: null, resolution: "partial" },
  ]);
});
