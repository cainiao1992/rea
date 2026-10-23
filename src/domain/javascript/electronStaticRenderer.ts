import * as t from "@babel/types";

import { electronCalleePath } from "./electronStaticAnalysisValues.js";
import {
  semanticStaticPropertyKey,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import { semanticBindingAtRead } from "./javascriptSemanticMutationInitializers.js";
import {
  semanticStableInitializer,
  type JavaScriptBindingIndex,
} from "./javascriptSemanticState.js";
import { completeSemanticSteps } from "./javascriptSemanticTraversal.js";
import type { JavaScriptFindingContext } from "./javascriptStaticAnalysisState.js";

/** A renderer load belongs to an intact, source-proven BrowserWindow instance. */
export const isElectronRendererLoad = (
  callee: t.Node,
  site: t.Node,
  context: JavaScriptFindingContext,
  index: JavaScriptBindingIndex,
): boolean => {
  callee = unwrapJavaScriptExpression(callee).node;
  if (!t.isMemberExpression(callee) && !t.isOptionalMemberExpression(callee))
    return false;
  const method = semanticStaticPropertyKey(callee.property, callee.computed);
  if (method !== "loadFile" && method !== "loadURL") return false;
  let receiver = unwrapJavaScriptExpression(callee.object).node;
  const path: string[] = [method];
  if (
    t.isMemberExpression(receiver) &&
    semanticStaticPropertyKey(receiver.property, receiver.computed) ===
      "webContents"
  ) {
    receiver = unwrapJavaScriptExpression(receiver.object).node;
    path.unshift("webContents");
  }
  const seen = new Set<string>();
  while (t.isIdentifier(receiver)) {
    const binding = index.bindingForReferenceAt(receiver);
    if (binding === undefined || seen.has(binding.bindingId)) return false;
    seen.add(binding.bindingId);
    const initializer = semanticStableInitializer(binding, index.bindings);
    if (
      initializer === undefined ||
      initializer.projection.length !== 0 ||
      !semanticBindingAtRead(binding, receiver, index.bindings.parentsByNode)
        .hasDefiniteInitializer
    )
      return false;
    completeSemanticSteps(index.indexMemberMutationFactsSteps());
    if (index.referenceMayHaveChangedAt(site, receiver, path)) return false;
    receiver = unwrapJavaScriptExpression(initializer.node).node;
  }
  if (!t.isNewExpression(receiver)) return false;
  const constructor = electronCalleePath(receiver.callee, context);
  return (
    constructor?.length === 1 &&
    constructor[0] === "BrowserWindow" &&
    context.electronExportIntact?.([
      "electron",
      "BrowserWindow",
      "prototype",
      ...path,
    ]) === true
  );
};
