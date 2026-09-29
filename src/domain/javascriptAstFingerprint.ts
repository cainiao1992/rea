import { createHash } from "node:crypto";

import * as t from "@babel/types";

/** Complete or prefix-only digest from a bounded AST traversal. */
export interface AstFingerprint {
  readonly sha256: string;
  readonly truncated: boolean;
}

/** Static CommonJS export names. */
export interface StaticExports {
  readonly values: readonly string[];
}

/** Derive a rename-resistant, bounded syntax fingerprint without code execution. */
export const fingerprintJavaScriptAst = (
  node: t.Node,
  maximumTokens: number,
): AstFingerprint => {
  const tokens: string[] = [];
  let truncated = false;
  t.traverseFast(node, (current) => {
    if (tokens.length >= maximumTokens) {
      truncated = true;
      return t.traverseFast.stop;
    }
    tokens.push(...semanticTokens(current));
    if (tokens.length > maximumTokens) {
      tokens.length = maximumTokens;
      truncated = true;
      return t.traverseFast.stop;
    }
    return undefined;
  });
  return {
    sha256: createHash("sha256").update(JSON.stringify(tokens)).digest("hex"),
    truncated,
  };
};

/** Collect statically declared CommonJS/bundler export names from one factory. */
export const collectJavaScriptExports = (node: t.Node): StaticExports => {
  const exports = new Set<string>();
  t.traverseFast(node, (current) => {
    if (t.isAssignmentExpression(current))
      collectAssignmentExports(current.left, current.right, exports);
    if (t.isCallExpression(current)) collectCallExports(current, exports);
    return undefined;
  });
  return {
    values: [...exports].sort(compareCodePoints),
  };
};

const semanticTokens = (node: t.Node): string[] => {
  const tokens = [`node:${node.type}`];
  if (t.isStringLiteral(node)) tokens.push(`string:${node.value}`);
  else if (t.isNumericLiteral(node))
    tokens.push(`number:${String(node.value)}`);
  else if (t.isBooleanLiteral(node))
    tokens.push(`boolean:${String(node.value)}`);
  else if (t.isRegExpLiteral(node))
    tokens.push(`regexp:${node.pattern}/${node.flags}`);
  else if (t.isBinaryExpression(node) || t.isLogicalExpression(node))
    tokens.push(`operator:${node.operator}`);
  else if (t.isUnaryExpression(node) || t.isUpdateExpression(node))
    tokens.push(`operator:${node.operator}`);
  if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) {
    const property = propertyName(node.property);
    if (property !== "") tokens.push(`property:${property}`);
  }
  if ((t.isObjectProperty(node) || t.isObjectMethod(node)) && !node.computed) {
    const key = propertyName(node.key);
    if (key !== "") tokens.push(`key:${key}`);
  }
  return tokens;
};

const collectAssignmentExports = (
  left: t.LVal | t.OptionalMemberExpression,
  right: t.Expression,
  output: Set<string>,
): void => {
  const path = memberPath(left);
  if (path === "exports" || path === "module.exports") {
    if (t.isObjectExpression(right)) collectObjectKeys(right, output);
    else addExport(output, "default");
    return;
  }
  if (path.startsWith("exports."))
    addExport(output, path.slice("exports.".length));
  if (path.startsWith("module.exports."))
    addExport(output, path.slice("module.exports.".length));
};

const collectCallExports = (
  call: t.CallExpression,
  output: Set<string>,
): void => {
  const callee = memberPath(call.callee);
  if (callee === "Object.defineProperty") {
    const target = memberPath(call.arguments[0]);
    const name = stringValue(call.arguments[1]);
    if ((target === "exports" || target === "module.exports") && name)
      addExport(output, name);
  }
  if (!callee.endsWith(".d")) return;
  const target = memberPath(call.arguments[0]);
  const declarations = call.arguments[1];
  if (
    (target === "exports" || target === "module.exports") &&
    t.isObjectExpression(declarations)
  )
    collectObjectKeys(declarations, output);
};

const collectObjectKeys = (
  object: t.ObjectExpression,
  output: Set<string>,
): void => {
  for (const property of object.properties) {
    if (!t.isObjectProperty(property) && !t.isObjectMethod(property)) continue;
    const name = propertyName(property.key);
    if (name !== "") addExport(output, name);
  }
};

const addExport = (output: Set<string>, name: string): void => {
  output.add(name);
};

const memberPath = (node: t.Node | null | undefined, depth = 0): string => {
  if (depth >= 128) return "[deep]";
  if (node === undefined || node === null) return "";
  if (t.isIdentifier(node) || t.isPrivateName(node))
    return t.isIdentifier(node) ? node.name : "";
  if (t.isThisExpression(node)) return "this";
  if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) {
    const object = t.isNode(node.object)
      ? memberPath(node.object, depth + 1)
      : "";
    const property = propertyName(node.property);
    return object === "" ? property : `${object}.${property}`;
  }
  return "";
};

const propertyName = (node: t.Node): string => {
  if (t.isIdentifier(node)) return node.name;
  if (t.isStringLiteral(node) || t.isNumericLiteral(node))
    return String(node.value);
  return "";
};

const stringValue = (node: t.Node | null | undefined): string | undefined =>
  t.isStringLiteral(node) ? node.value : undefined;

const compareCodePoints = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;
