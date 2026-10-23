import { expect, it } from "vitest";
import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";
import { onlyCallable } from "./javascriptSemanticAnalysis.fixture.js";

const names = (source: string) =>
  analyzeJavaScriptSemantics(source)
    .moduleLinks.filter(({ kind }) => kind === "commonjs-export")
    .map(({ exportedName }) => exportedName);

it("keeps uncertain invocation spreads distinct from ordinary array sources", () => {
  expect(
    names("const args=[{alpha:1,beta:2}];Object.assign(exports,...args);"),
  ).toEqual(["*"]);
  expect(names("Object.assign(exports,...[{alpha:1,beta:2}]);").sort()).toEqual(
    ["alpha", "beta"],
  );
  expect(names("Object.assign(exports,[{alpha:1,beta:2}]);")).toEqual(["0"]);
});

it("removes named exports after definite deletion without removing an intact or later export", () => {
  const ir = analyzeJavaScriptSemantics(`
    exports.deleted=function(){return {value:1}}; delete exports.deleted;
    module.exports.replaced=function(){return {value:1}}; delete module.exports.replaced;
    exports.replaced=function(){return {value:2}};
    exports.intact=function(){return {value:3}};
  `);
  const links = ir.moduleLinks.filter(({ kind }) => kind === "commonjs-export");
  expect(links.map(({ exportedName }) => exportedName).sort()).toEqual([
    "intact",
    "replaced",
  ]);
  expect(links.every(({ callableId }) => callableId !== null)).toBe(true);
});

it("keeps conditionally deleted CommonJS exports uncertain", () => {
  const ir = analyzeJavaScriptSemantics(
    "exports.read=function(){return {value:1}}; if(flag)delete exports.read;",
  );
  expect(
    ir.moduleLinks.find(({ kind }) => kind === "commonjs-export")?.callableId,
  ).toBeNull();
});

it("retains captured object-copy literals and known logical/conditional values", () => {
  const ir = analyzeJavaScriptSemantics(`export function observe(){
    const source={a:1,b:2}; const copy={...source,b:3}; source.a=9;
    const yes=true; const no=false;
    return {copied:copy.a, overwritten:copy.b, conditional:yes ? 1 : 2, or:yes || 2, and:no && 2, nullish:1 ?? 2};
  }`);
  expect(onlyCallable(ir, "observe").returnSites[0]?.value).toMatchObject({
    status: "object",
    unknownProperties: false,
    properties: [
      { name: "and", value: { status: "literal", value: false } },
      { name: "conditional", value: { status: "literal", value: 1 } },
      { name: "copied", value: { status: "literal", value: 1 } },
      { name: "nullish", value: { status: "literal", value: 1 } },
      { name: "or", value: { status: "literal", value: true } },
      { name: "overwritten", value: { status: "literal", value: 3 } },
    ],
  });
});
