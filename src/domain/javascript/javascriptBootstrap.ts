import * as t from "@babel/types";

import { semanticStaticPropertyKey } from "./javascriptAstValues.js";
import { moduleFactory } from "./javascriptStaticAnalysisHelpers.js";
import { traverseJavaScriptAst } from "./javascriptSemanticTraversal.js";

/** A literal module table dispatched by a standalone CommonJS-style runtime. */
interface JavaScriptBootstrap {
  readonly body: t.BlockStatement;
  readonly table: t.ObjectExpression;
  readonly loaderName: string;
}

/** Recognize syntax, never invoke a bootstrap or infer it from variable names. */
export const javascriptBootstrapAt = (
  call: t.CallExpression,
): JavaScriptBootstrap | undefined => {
  if (
    (!t.isFunctionExpression(call.callee) &&
      !t.isArrowFunctionExpression(call.callee)) ||
    !t.isBlockStatement(call.callee.body) ||
    call.callee.params.length !== 0 ||
    call.arguments.length !== 0
  )
    return undefined;
  const body = call.callee.body;
  const tables = new Map<string, t.ObjectExpression>();
  for (const statement of body.body) {
    if (!t.isVariableDeclaration(statement)) continue;
    for (const declaration of statement.declarations) {
      if (
        t.isIdentifier(declaration.id) &&
        t.isObjectExpression(declaration.init) &&
        declaration.init.properties.length > 0 &&
        declaration.init.properties.every(
          (property) => moduleFactory(property) !== undefined,
        )
      )
        tables.set(declaration.id.name, declaration.init);
    }
  }
  if (tables.size === 0) return undefined;
  for (const loader of body.body) {
    if (
      !t.isFunctionDeclaration(loader) ||
      loader.id === null ||
      loader.id === undefined ||
      loader.params.length !== 1
    )
      continue;
    const parameter = loader.params[0];
    if (!t.isIdentifier(parameter)) continue;
    const loaderName = loader.id.name;
    let tableName: string | undefined;
    traverseJavaScriptAst(loader.body, {
      enter: (node, _parent, ancestors) => {
        if (
          !t.isCallExpression(node) ||
          ancestors().some((node) => t.isFunction(node))
        )
          return;
        const candidate = dispatchedTableName(node, loaderName, parameter.name);
        if (candidate !== undefined && tables.has(candidate))
          tableName = candidate;
      },
    });
    const table = tableName === undefined ? undefined : tables.get(tableName);
    if (table !== undefined && tableName !== undefined)
      return { body, table, loaderName };
  }
  return undefined;
};

const dispatchedTableName = (
  call: t.CallExpression,
  loaderName: string,
  keyName: string,
): string | undefined => {
  const member = call.callee;
  const viaCall =
    t.isMemberExpression(member) &&
    semanticStaticPropertyKey(member.property, member.computed) === "call";
  const dispatch =
    viaCall && t.isMemberExpression(member) ? member.object : member;
  if (
    !t.isMemberExpression(dispatch) ||
    !dispatch.computed ||
    !t.isIdentifier(dispatch.object) ||
    !t.isIdentifier(dispatch.property, { name: keyName })
  )
    return undefined;
  const args = viaCall ? call.arguments.slice(1) : call.arguments;
  const [module, exports, require] = args;
  if (
    args.length !== 3 ||
    !t.isIdentifier(module) ||
    !t.isMemberExpression(exports) ||
    !t.isIdentifier(exports.object, { name: module.name }) ||
    semanticStaticPropertyKey(exports.property, exports.computed) !==
      "exports" ||
    !t.isIdentifier(require, { name: loaderName })
  )
    return undefined;
  if (
    viaCall &&
    (!t.isNode(call.arguments[0]) ||
      !t.isNodesEquivalent(call.arguments[0], exports))
  )
    return undefined;
  return dispatch.object.name;
};
