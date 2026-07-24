import * as t from "@babel/types";

import {
  reachSemanticLimit,
  semanticCallableIdForNode,
  semanticStaticPropertyName,
} from "./javascriptSemanticProjection.js";
import {
  resolveSemanticBindingState,
  semanticResolutionBlocked,
  type JavaScriptSemanticAnalysisState,
  type JavaScriptSemanticBindingState,
} from "./javascriptSemanticState.js";
import { traverseJavaScriptAst } from "./javascriptSemanticTraversal.js";

/** Shared mutable stacks reset before each deterministic data-effect pass. */
export interface DataEffectTraversalContext {
  readonly state: JavaScriptSemanticAnalysisState;
  readonly callableIds: ReadonlySet<string>;
  readonly callableStack: string[];
  readonly ancestors: t.Node[];
}

/** Resolve a direct or namespace-imported built-in method. */
export const builtinDataEffectMethod = (
  callee: t.Node,
  state: JavaScriptSemanticAnalysisState,
  specifiers: readonly string[],
): string | null => {
  if (t.isIdentifier(callee)) {
    const binding = resolveSemanticBindingState(state, callee, callee.name);
    return moduleMethod(binding, specifiers);
  }
  if (!t.isMemberExpression(callee) && !t.isOptionalMemberExpression(callee))
    return null;
  if (!t.isIdentifier(callee.object)) return null;
  const binding = resolveSemanticBindingState(
    state,
    callee.object,
    callee.object.name,
  );
  const namespace = binding?.directOrigins.some(
    ({ specifier, importedPath }) =>
      specifiers.includes(specifier) && importedPath.length === 0,
  );
  return namespace
    ? semanticStaticPropertyName(callee.property, callee.computed)
    : null;
};

const moduleMethod = (
  binding: JavaScriptSemanticBindingState | undefined,
  specifiers: readonly string[],
): string | null => {
  for (const { specifier, importedPath } of binding?.directOrigins ?? []) {
    if (!specifiers.includes(specifier)) continue;
    return importedPath.at(-1) ?? null;
  }
  return null;
};

/** Recognize global or node:process aliases without accepting shadowing. */
export const isSemanticProcessObject = (
  node: t.Expression | t.Super,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  if (!t.isIdentifier(node)) return false;
  const binding = resolveSemanticBindingState(state, node, node.name);
  if (binding === undefined)
    return (
      node.name === "process" &&
      !semanticResolutionBlocked(state, node, node.name)
    );
  return binding.directOrigins.some(
    ({ specifier }) => specifier === "process" || specifier === "node:process",
  );
};

/** Resolve the nearest direct variable/assignment owner before a callable. */
export const outerDataEffectBinding = (
  node: t.Node,
  context: DataEffectTraversalContext,
): string | null => {
  for (let index = context.ancestors.length - 1; index >= 0; index -= 1) {
    const ancestor = context.ancestors[index];
    if (ancestor === undefined) continue;
    if (
      t.isVariableDeclarator(ancestor) &&
      t.isNode(ancestor.init) &&
      containsSemanticNode(ancestor.init, node) &&
      t.isIdentifier(ancestor.id)
    )
      return (
        resolveSemanticBindingState(
          context.state,
          ancestor.id,
          ancestor.id.name,
        )?.bindingId ?? null
      );
    if (
      t.isAssignmentExpression(ancestor) &&
      containsSemanticNode(ancestor.right, node) &&
      t.isIdentifier(ancestor.left)
    )
      return (
        resolveSemanticBindingState(
          context.state,
          ancestor.left,
          ancestor.left.name,
        )?.bindingId ?? null
      );
    if (semanticCallableIdForNode(ancestor) !== null) return null;
  }
  return null;
};

/** Traverse with exact callable and ancestor stacks. */
export const traverseDataEffects = (
  program: t.Program,
  context: DataEffectTraversalContext,
  visit: (node: t.Node, parent: t.Node | null) => void,
): void => {
  context.callableStack.length = 0;
  context.ancestors.length = 0;
  traverseJavaScriptAst(program, {
    enter: (node, parent) => {
      const callableId = semanticCallableIdForNode(node);
      if (callableId !== null && context.callableIds.has(callableId))
        context.callableStack.push(callableId);
      visit(node, parent);
      context.ancestors.push(node);
    },
    exit: (node) => {
      context.ancestors.pop();
      const callableId = semanticCallableIdForNode(node);
      if (callableId !== null && context.callableStack.at(-1) === callableId)
        context.callableStack.pop();
    },
  });
};

/** Resolve one direct identifier argument to a lexical binding. */
export const dataEffectArgumentBindingId = (
  node:
    | t.Expression
    | t.SpreadElement
    | t.JSXNamespacedName
    | t.ArgumentPlaceholder
    | undefined,
  state: JavaScriptSemanticAnalysisState,
): string | null =>
  t.isIdentifier(node)
    ? (resolveSemanticBindingState(state, node, node.name)?.bindingId ?? null)
    : null;

/** Read one JSON primitive default without evaluating code. */
export const dataEffectPrimitive = (
  node: t.Node,
): string | number | boolean | null => {
  if (t.isStringLiteral(node) || t.isNumericLiteral(node)) return node.value;
  if (t.isBooleanLiteral(node)) return node.value;
  return null;
};

/** Read one static string or expression-free template. */
export const dataEffectLiteralString = (
  node:
    | t.Expression
    | t.SpreadElement
    | t.JSXNamespacedName
    | t.ArgumentPlaceholder
    | undefined,
): string | null => {
  if (t.isStringLiteral(node)) return node.value;
  if (t.isTemplateLiteral(node) && node.expressions.length === 0)
    return node.quasis[0]?.value.cooked ?? node.quasis[0]?.value.raw ?? null;
  return null;
};

/** Read a member callee from call or construction syntax. */
export const dataEffectMemberCallee = (
  node: t.CallExpression | t.OptionalCallExpression | t.NewExpression,
): t.MemberExpression | t.OptionalMemberExpression | null =>
  t.isMemberExpression(node.callee) || t.isOptionalMemberExpression(node.callee)
    ? node.callee
    : null;

/** Read a parent member's object when present. */
export const dataEffectMemberObject = (
  node: t.Node | null,
): t.Expression | t.Super | null =>
  node !== null &&
  (t.isMemberExpression(node) || t.isOptionalMemberExpression(node))
    ? node.object
    : null;

/** Compare Babel source offsets for exact containment. */
export const containsSemanticNode = (outer: t.Node, inner: t.Node): boolean =>
  outer.start !== null &&
  outer.start !== undefined &&
  outer.end !== null &&
  outer.end !== undefined &&
  inner.start !== null &&
  inner.start !== undefined &&
  inner.end !== null &&
  inner.end !== undefined &&
  outer.start <= inner.start &&
  outer.end >= inner.end;

/** Record one bounded data-effect frontier. */
export const dataEffectLimitReached = (
  retained: number,
  limit: number,
  name:
    | "maxConfigurationOperations"
    | "maxRequestOperations"
    | "maxBoundaryOperations"
    | "maxResourceOperations",
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  if (retained < limit) return false;
  reachSemanticLimit(state, name);
  return true;
};
