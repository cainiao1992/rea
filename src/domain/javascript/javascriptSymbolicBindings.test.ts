import { expect, it } from "vitest";
import * as t from "@babel/types";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";
import { indexJavaScriptBindingsSteps } from "./javascriptSemanticAnalysis.js";
import {
  completeSemanticSteps,
  traverseJavaScriptAst,
} from "./javascriptSemanticTraversal.js";
import { JavaScriptSymbolicBindings } from "./javascriptSymbolicBindings.js";
import { symbolicVariants } from "./javascriptSymbolicValues.js";

it("substitutes numeric modules, named exports and captured wrapper arguments", () => {
  const parsed = parseJavaScriptSource(`(() => {
    const modules = {
      4(module) { module.exports = require("electron"); },
      8(module, exports, load) {
        const electron = load(4);
        exports.sender = function(channel) { return (...args) => electron.ipcRenderer.send(channel,...args); };
      },
      12(module, exports, load) { const helpers = load(8); const api = {copy: helpers.sender("test:copy")}; inspect(api.copy); }
    };
    function load(id) { const m = {exports:{}}; modules[id](m,m.exports,load); return m.exports; }
    load(12);
  })();`)!;
  const state = completeSemanticSteps(
    indexJavaScriptBindingsSteps(parsed.program),
  );
  const resolver = new JavaScriptSymbolicBindings(state, parsed.program);
  let found = false;
  traverseJavaScriptAst(parsed.program, {
    enter: (node) => {
      if (
        !t.isCallExpression(node) ||
        !t.isIdentifier(node.callee, { name: "inspect" })
      )
        return;
      const value = resolver.evaluate(node.arguments[0]);
      const fn = symbolicVariants(value).find((v) => v.kind === "function");
      expect(fn?.kind).toBe("function");
      if (fn?.kind !== "function" || !t.isCallExpression(fn.node.body))
        throw new Error("closure missing");
      const env = resolver.bind(fn, []);
      expect(resolver.evaluate(fn.node.body.callee, env)).toEqual({
        kind: "external",
        path: ["electron", "ipcRenderer", "send"],
      });
      expect(resolver.arguments(fn.node.body, env)[0]).toEqual({
        kind: "literal",
        value: "test:copy",
      });
      found = true;
    },
  });
  expect(found).toBe(true);
});
