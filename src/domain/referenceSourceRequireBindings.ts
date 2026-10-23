import * as t from "@babel/types";

import { semanticStaticPropertyKey } from "./javascript/javascriptAstValues.js";
import { isUnmodifiedGlobalReference } from "./javascript/javascriptSemanticAmbientWrites.js";
import {
  indexJavaScriptBindingsWithReceiversSteps,
  type JavaScriptReceiverIndex,
} from "./javascript/javascriptSemanticAnalysis.js";
import type { JavaScriptSemanticAnalysisState } from "./javascript/javascriptSemanticState.js";
import {
  semanticRequireCallAt,
  semanticRequireLoaderAt,
} from "./javascript/javascriptSemanticRequireOrigin.js";
import {
  completeSemanticSteps,
  traverseJavaScriptAst,
} from "./javascript/javascriptSemanticTraversal.js";
import {
  isExplicitModuleSourcePath,
  type ParsedJavaScriptSource,
} from "./javascript/javascriptSourceParser.js";

export type ReferenceSourceRequireResolutionBase = "source-file" | "unknown";

/** Identify exact calls through a source-owned Node loader and their resolver base. */
export const referenceSourceRequireCallBases = (
  file: Pick<ParsedJavaScriptSource, "program">,
  path: string,
): ReadonlyMap<t.CallExpression, ReferenceSourceRequireResolutionBase> => {
  // Unmarked paths depend on package scope or compiler options. Preserve their
  // candidate CommonJS edges; explicit module paths have no wrapper loader.
  const wrapperMode = commonJsWrapperMode(path);
  const index = completeSemanticSteps(
    indexJavaScriptBindingsWithReceiversSteps(
      file.program,
      wrapperMode === "absent" ? undefined : "commonjs-wrapper",
    ),
  );
  const factoryBindings: ReadonlySet<string> = new Set();
  const candidates: {
    readonly call: t.CallExpression;
    readonly identifier: t.Identifier;
    readonly resolutionBase: ReferenceSourceRequireResolutionBase;
  }[] = [];
  traverseJavaScriptAst(file.program, {
    enter: (node) => {
      if (!t.isCallExpression(node)) return;
      const identifier = requireCalleeIdentifier(node.callee);
      if (identifier === undefined) return;
      let fact = semanticRequireLoaderAt(node, index.bindings, factoryBindings);
      if (fact === "create-require") {
        // Definitions identify a possible factory. Its mutable member reads
        // need the shared write index before they can prove an association.
        completeSemanticSteps(index.indexMemberMutationFactsSteps());
        fact = semanticRequireLoaderAt(node, index.bindings, factoryBindings);
      }
      if (
        fact !== "create-require" &&
        (fact !== "commonjs-loader" || wrapperMode === "absent")
      )
        return;
      const callFact = semanticRequireCallAt(
        node,
        index.bindings,
        factoryBindings,
      );
      const base =
        fact === "create-require"
          ? callFact?.sourceRelative === true
            ? "source-file"
            : "unknown"
          : "source-file";
      candidates.push({
        call: node,
        identifier,
        resolutionBase:
          base === "source-file" &&
          isDefaultRequireResolveSearch(node, index.bindings)
            ? "source-file"
            : "unknown",
      });
    },
  });
  if (candidates.some(({ call }) => !t.isIdentifier(call.callee)))
    completeSemanticSteps(index.indexMemberMutationFactsSteps());
  return new Map(
    candidates
      .filter(
        ({ call, identifier }) =>
          t.isIdentifier(call.callee) ||
          !hasPriorMemberMutation(index, call, identifier),
      )
      .map(({ call, resolutionBase }) => [call, resolutionBase] as const),
  );
};

/** `require.resolve` options replace the default search paths unless exact current-directory paths are supplied. */
const isDefaultRequireResolveSearch = (
  call: t.CallExpression,
  bindings: JavaScriptSemanticAnalysisState,
): boolean => {
  if (!isRequireResolveCall(call) || call.arguments.length < 2) return true;
  if (call.arguments.length !== 2) return false;
  const options = t.isExpression(call.arguments[1])
    ? call.arguments[1]
    : undefined;
  if (options === undefined) return false;
  if (!t.isObjectExpression(options)) return false;
  if (options.properties.length === 0) return true;
  if (options.properties.length !== 1) return false;
  const property = options.properties[0];
  if (!t.isObjectProperty(property)) return false;
  if (semanticStaticPropertyKey(property.key, property.computed) !== "paths")
    return false;
  const value = t.isExpression(property.value) ? property.value : undefined;
  if (!t.isArrayExpression(value) || value.elements.length !== 1) return false;
  const directory = value.elements[0];
  return (
    t.isIdentifier(directory, { name: "__dirname" }) &&
    isUnmodifiedGlobalReference(directory, bindings, "__dirname")
  );
};

const isRequireResolveCall = (call: t.CallExpression): boolean => {
  const callee = call.callee;
  if (
    !t.isMemberExpression(callee) ||
    !t.isIdentifier(callee.object, { name: "require" })
  )
    return false;
  return (
    semanticStaticPropertyKey(callee.property, callee.computed) === "resolve"
  );
};

type CommonJsWrapperMode = "present" | "absent" | "unknown";

const commonJsWrapperMode = (path: string): CommonJsWrapperMode =>
  path.endsWith(".cjs")
    ? "present"
    : path.endsWith(".mjs")
      ? "absent"
      : isExplicitModuleSourcePath(path)
        ? "absent"
        : "unknown";

const hasPriorMemberMutation = (
  index: JavaScriptReceiverIndex,
  site: t.CallExpression,
  identifier: t.Identifier,
): boolean => {
  const callee = site.callee;
  const property = t.isMemberExpression(callee)
    ? semanticStaticPropertyKey(callee.property, callee.computed)
    : undefined;
  if (property === undefined || property === null) return true;
  const facts = index.effectsForReferenceAt(site, identifier, [property]);
  return (
    !facts.memberEffectsIndexed ||
    facts.effects.some(
      ({ kind, timing }) =>
        (kind === "member-write" || kind === "escape") && timing !== "after",
    )
  );
};

const requireCalleeIdentifier = (
  callee: t.Node | null | undefined,
): t.Identifier | undefined => {
  if (t.isIdentifier(callee, { name: "require" })) return callee;
  if (
    !t.isMemberExpression(callee) ||
    !t.isIdentifier(callee.object, { name: "require" }) ||
    ((!t.isIdentifier(callee.property) || callee.computed) &&
      !t.isStringLiteral(callee.property))
  )
    return undefined;
  const propertyName = t.isIdentifier(callee.property)
    ? callee.property.name
    : t.isStringLiteral(callee.property)
      ? callee.property.value
      : undefined;
  return propertyName === "resolve" || propertyName === "main"
    ? callee.object
    : undefined;
};
