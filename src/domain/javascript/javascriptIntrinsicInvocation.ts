import * as t from "@babel/types";

import type { JavaScriptIntrinsicInvocation } from "./javascriptElectronMemberWrites.js";
import {
  semanticStaticPropertyKey,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";

const arrayArguments = (array: t.Node | undefined) =>
  t.isArrayExpression(array) &&
  array.elements.every((element) => t.isExpression(element))
    ? array.elements.filter((element): element is t.Expression =>
        t.isExpression(element),
      )
    : undefined;

const invocationArguments = (
  method: "call" | "apply",
  arguments_: JavaScriptIntrinsicInvocation["arguments"],
) =>
  t.isSpreadElement(arguments_?.[0])
    ? undefined
    : method === "apply"
      ? arrayArguments(arguments_?.[1])
      : arguments_?.slice(1);

/**
 * Normalize known invocation syntax once, retaining bound argument prefixes.
 * Binding a function alone is not a write; only its eventual call is examined.
 */
export const resolveJavaScriptIntrinsicInvocation = (
  node: t.CallExpression | t.OptionalCallExpression,
  intrinsicPath: (node: t.Node) => readonly string[] | undefined,
  boundIntrinsic: (node: t.Node) => JavaScriptIntrinsicInvocation | undefined,
  intrinsicReadChanged: (node: t.Node, path: readonly string[]) => boolean,
): JavaScriptIntrinsicInvocation | undefined => {
  const visited = new Set<t.Node>();
  let callee: t.Node = node.callee;
  let arguments_: JavaScriptIntrinsicInvocation["arguments"] = node.arguments;
  let receiver: t.Node | undefined;
  for (;;) {
    callee = unwrapJavaScriptExpression(callee).node;
    if (visited.has(callee)) return undefined;
    visited.add(callee);
    let path = intrinsicPath(callee);
    if (path !== undefined && intrinsicReadChanged(callee, path))
      return { kind: "opaque", path, arguments: undefined };
    if (path === undefined) {
      if (
        t.isMemberExpression(callee) ||
        t.isOptionalMemberExpression(callee)
      ) {
        const method = semanticStaticPropertyKey(
          callee.property,
          callee.computed,
        );
        if (method === "call" || method === "apply") {
          const bound = boundIntrinsic(callee.object);
          if (
            bound !== undefined &&
            intrinsicReadChanged(callee, [...bound.path, method])
          )
            return { kind: "opaque", path: bound.path, arguments: undefined };
          receiver = arguments_?.[0];
          callee = callee.object;
          arguments_ = invocationArguments(method, arguments_);
          continue;
        }
      }
      const bound = boundIntrinsic(callee);
      if (bound === undefined) return undefined;
      if (bound.kind === "opaque") return bound;
      path = bound.path;
      receiver = bound.receiver;
      arguments_ =
        bound.arguments === undefined
          ? undefined
          : [...bound.arguments, ...(arguments_ ?? [])];
    }
    // A projected .call/.apply invokes the preceding callable. The actual
    // Function.prototype methods instead invoke their receiver, retained by bind.
    while (path.length > 3 && !genericInvocationMethod(path)) {
      const method = path.at(-1);
      if (method !== "call" && method !== "apply") break;
      receiver = arguments_?.[0];
      arguments_ = invocationArguments(method, arguments_);
      path = path.slice(0, -1);
    }
    const genericMethod = genericInvocationMethod(path);
    if (genericMethod !== undefined) {
      if (!t.isExpression(receiver)) return undefined;
      callee = receiver;
      receiver = arguments_?.[0];
      arguments_ = invocationArguments(genericMethod, arguments_);
      continue;
    }
    if (path.join(".") === "intrinsic.Reflect.apply") {
      const callable = arguments_?.[0];
      if (!t.isExpression(callable)) return undefined;
      callee = callable;
      receiver = arguments_?.[1];
      arguments_ = arrayArguments(arguments_?.[2]);
      continue;
    }
    return {
      kind: "known",
      path,
      arguments: arguments_,
      ...(receiver === undefined ? {} : { receiver }),
    };
  }
};

const genericInvocationMethod = (
  path: readonly string[],
): "call" | "apply" | undefined =>
  path.length === 4 &&
  path[0] === "intrinsic" &&
  path[1] === "Function" &&
  path[2] === "prototype" &&
  (path[3] === "call" || path[3] === "apply")
    ? path[3]
    : undefined;
