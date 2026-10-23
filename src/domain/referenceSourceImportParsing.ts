import type {
  CallExpression,
  File,
  ImportExpression,
  Node,
  StringLiteral,
} from "@babel/types";
import { traverseJavaScriptAst } from "./javascript/javascriptSemanticTraversal.js";
import { readExactJavaScriptLiteral } from "./javascript/javascriptAstValues.js";
import {
  parseRecoveredJavaScript,
  parserPluginsForPath,
} from "./javascript/javascriptSourceParser.js";
import {
  referenceSourceRequireCalls,
  type ReferenceSourceRequireCall,
} from "./referenceSourceRequireBindings.js";
import { isRelativeJavaScriptModuleSpecifier } from "./javascript/javascriptModuleSpecifier.js";
import {
  isCallExpression,
  isExportAllDeclaration,
  isExportNamedDeclaration,
  isImport,
  isImportDeclaration,
  isImportExpression,
  isStringLiteral,
  isTSExternalModuleReference,
  isTSImportEqualsDeclaration,
  isTSModuleDeclaration,
} from "@babel/types";

type ReferenceSourceImportKind =
  | "imports"
  | "requires"
  | "references"
  | "declares-module";

type ReferenceSourceImportResolution =
  | "internal"
  | "external"
  | "unresolved"
  | "unknown";

type ReferenceSourceImportParseState = "parsed" | "partial" | "unknown";

interface ReferenceSourceImportRelationship {
  readonly from_path: string;
  readonly to: string;
  readonly kind: ReferenceSourceImportKind;
  readonly resolution: ReferenceSourceImportResolution;
  readonly parse_state: ReferenceSourceImportParseState;
  /** Distinguishes call-form CommonJS require from TS import-equals `requires`. */
  readonly resolutionStrategy?: "runtime-require";
  /** Internal lookup origin for a proven createRequire URL base. */
  readonly resolutionBasePath?: string;
}

interface ReferenceSourceParseFailure {
  readonly path: string;
  readonly parser: string;
  readonly reason: string;
}

export interface ReferenceSourceImportParseResult {
  readonly relationships: readonly ReferenceSourceImportRelationship[];
  readonly parse_failures: readonly ReferenceSourceParseFailure[];
  readonly limitations: readonly string[];
}

export const PARSEABLE_REFERENCE_SOURCE_LANGUAGES: ReadonlySet<string> =
  new Set(["JavaScript", "TypeScript", "JSX", "TSX"]);

const safeModuleName = (node: Node | null | undefined): string | undefined => {
  if (isStringLiteral(node)) return node.value;
  return undefined;
};

const exactStringModuleName = (
  node: Node | null | undefined,
): string | undefined => {
  if (node === null || node === undefined) return undefined;
  const literal = readExactJavaScriptLiteral(node);
  return literal.found && typeof literal.value === "string"
    ? literal.value
    : undefined;
};

const resolveSpecifier = (
  specifier: string,
): ReferenceSourceImportResolution => {
  if (
    isRelativeJavaScriptModuleSpecifier(specifier) ||
    specifier.startsWith("/")
  )
    return "internal";
  return "external";
};

const isModuleExpression = (
  expression: Node | null | undefined,
): expression is StringLiteral | CallExpression =>
  isStringLiteral(expression) || isCallExpression(expression);

const moduleSpecifierFromExpression = (
  expression: Node | null | undefined,
):
  | { specifier: string; parseState: ReferenceSourceImportParseState }
  | undefined => {
  const specifier = exactStringModuleName(expression);
  if (specifier !== undefined) return { specifier, parseState: "parsed" };
  if (
    isCallExpression(expression) &&
    isImport(expression.callee) &&
    expression.arguments.length > 0
  ) {
    const nestedSpecifier = exactStringModuleName(expression.arguments[0]);
    return nestedSpecifier === undefined
      ? { specifier: "<dynamic-import>", parseState: "partial" }
      : { specifier: nestedSpecifier, parseState: "parsed" };
  }
  return undefined;
};

const appendRelationship = (
  relationships: ReferenceSourceImportRelationship[],
  limitations: string[],
  input: {
    readonly fromPath: string;
    readonly to: string | undefined;
    readonly kind: ReferenceSourceImportKind;
    readonly parseState: ReferenceSourceImportParseState;
    readonly resolution?: ReferenceSourceImportResolution;
    readonly resolutionStrategy?: "runtime-require";
    readonly resolutionBasePath?: string;
  },
): void => {
  if (input.to === undefined) return;
  if (input.to.length === 0) {
    limitations.push(
      `Empty module specifier in ${input.fromPath} was not recorded as a relationship.`,
    );
    return;
  }
  relationships.push({
    from_path: input.fromPath,
    to: input.to,
    kind: input.kind,
    resolution: input.resolution ?? resolveSpecifier(input.to),
    parse_state: input.parseState,
    ...(input.resolutionStrategy === undefined
      ? {}
      : { resolutionStrategy: input.resolutionStrategy }),
    ...(input.resolutionBasePath === undefined
      ? {}
      : { resolutionBasePath: input.resolutionBasePath }),
  });
};

const appendImportEquals = (
  statement: Node,
  from_path: string,
  relationships: ReferenceSourceImportRelationship[],
  limitations: string[],
): void => {
  if (!isTSImportEqualsDeclaration(statement)) return;
  const reference = statement.moduleReference;
  if (!isTSExternalModuleReference(reference)) return;
  appendRelationship(relationships, limitations, {
    fromPath: from_path,
    to: safeModuleName(reference.expression),
    kind: "requires",
    parseState: "parsed",
  });
};

const extractImportDeclarations = (
  body: readonly Node[],
  from_path: string,
  relationships: ReferenceSourceImportRelationship[],
  limitations: string[],
): void => {
  for (const statement of body) {
    if (isImportDeclaration(statement)) {
      appendRelationship(relationships, limitations, {
        fromPath: from_path,
        to: safeModuleName(statement.source),
        kind: "imports",
        parseState: "parsed",
      });
      continue;
    }

    if (isExportNamedDeclaration(statement)) {
      if (statement.source !== null && statement.source !== undefined) {
        appendRelationship(relationships, limitations, {
          fromPath: from_path,
          to: safeModuleName(statement.source),
          kind: "imports",
          parseState: "parsed",
        });
      } else if (
        statement.declaration !== null &&
        statement.declaration !== undefined
      )
        appendImportEquals(
          statement.declaration,
          from_path,
          relationships,
          limitations,
        );
      continue;
    }

    if (isExportAllDeclaration(statement)) {
      appendRelationship(relationships, limitations, {
        fromPath: from_path,
        to: safeModuleName(statement.source),
        kind: "imports",
        parseState: "parsed",
      });
      continue;
    }

    if (isTSImportEqualsDeclaration(statement)) {
      appendImportEquals(statement, from_path, relationships, limitations);
      continue;
    }

    if (isTSModuleDeclaration(statement)) {
      if (statement.declare === true && isStringLiteral(statement.id)) {
        appendRelationship(relationships, limitations, {
          fromPath: from_path,
          to: statement.id.value,
          kind: "declares-module",
          parseState: "parsed",
          resolution: "unknown",
        });
      }
    }
  }
};

const extractRequireAndDynamicImports = (
  body: readonly Node[],
  from_path: string,
  relationships: ReferenceSourceImportRelationship[],
  limitations: string[],
  requireCalls: ReadonlyMap<CallExpression, ReferenceSourceRequireCall>,
): void => {
  // Single traversal owner: iterative, VISITOR_KEYS-gated, no recursion over
  // loc/comment objects. Survives deeply nested generated member chains that
  // overflowed the previous hand-rolled Object.values walker.
  const expressions: Array<CallExpression | ImportExpression> = [];
  for (const statement of body)
    traverseJavaScriptAst(statement, {
      enter: (node) => {
        if (isCallExpression(node) || isImportExpression(node))
          expressions.push(node);
      },
    });

  for (const call of expressions) {
    if (isImportExpression(call)) {
      const specifier = exactStringModuleName(call.source);
      appendRelationship(relationships, limitations, {
        fromPath: from_path,
        to: specifier ?? "<dynamic-import>",
        kind: "imports",
        parseState: specifier === undefined ? "partial" : "parsed",
        ...(specifier === undefined ? { resolution: "unknown" } : {}),
      });
      continue;
    }
    // The shared exact-literal reader owns argument exactness: it unwraps
    // runtime-transparent TS wrappers (`as const`, `!`, `satisfies`) and
    // admits quoted and expression-free template spellings alike.
    const requireCall = requireCalls.get(call);
    if (requireCall !== undefined) {
      const result = moduleSpecifierFromExpression(requireCall.arguments?.[0]);
      if (result !== undefined) {
        const uncertainResolution = requireCall.resolutionBase === "unknown";
        appendRelationship(relationships, limitations, {
          fromPath: from_path,
          to: result.specifier,
          kind: "requires",
          parseState: uncertainResolution ? "partial" : result.parseState,
          ...(uncertainResolution ? { resolution: "unknown" } : {}),
          ...(uncertainResolution
            ? {}
            : { resolutionStrategy: "runtime-require" as const }),
          ...(typeof requireCall.resolutionBase === "object"
            ? {
                resolutionBasePath: requireCall.resolutionBase.path,
              }
            : {}),
        });
      }
      continue;
    }

    const first = call.arguments[0];
    if (isImport(call.callee) && isModuleExpression(first)) {
      const result = moduleSpecifierFromExpression(first);
      if (result !== undefined) {
        appendRelationship(relationships, limitations, {
          fromPath: from_path,
          to: result.specifier,
          kind: "imports",
          parseState: result.parseState,
        });
      }
    }
  }
};

const parseWithBabel = (
  path: string,
  source: string,
  language: string | null,
): {
  ast: File | undefined;
  reasons: readonly string[];
  moduleOnlyErrors: readonly string[];
} => {
  // Single parser-mode owner: path-driven plugins (dts/JSX/mts) shared with
  // the semantic pipeline. `language` only gates non-JS/TS callers upstream;
  // TypeScript syntax must parse identically here and in semantic analysis.
  void language;
  const plugins = parserPluginsForPath(path);

  try {
    const { file: ast, moduleOnlyErrors } = parseRecoveredJavaScript(
      source,
      path,
      {
        allowImportExportEverywhere: false,
        allowReturnOutsideFunction: true,
        allowUndeclaredExports: true,
        plugins,
      },
    );
    return {
      ast,
      reasons: ast.errors.map((error) => error.message),
      moduleOnlyErrors,
    };
  } catch (cause: unknown) {
    return {
      ast: undefined,
      reasons: [cause instanceof Error ? cause.message : "Parse failed"],
      moduleOnlyErrors: [],
    };
  }
};

/** Parse ESM/CommonJS imports and dynamic imports from source bytes. */
export const parseReferenceSourceImports = (
  path: string,
  bytes: Uint8Array,
  language: string | null,
): ReferenceSourceImportParseResult => {
  if (language !== null && !PARSEABLE_REFERENCE_SOURCE_LANGUAGES.has(language))
    return { relationships: [], parse_failures: [], limitations: [] };

  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return {
      relationships: [],
      parse_failures: [
        {
          path,
          parser: "utf-8",
          reason:
            "Source bytes are not valid UTF-8; import targets were not parsed.",
        },
      ],
      limitations: [],
    };
  }
  const { ast, reasons, moduleOnlyErrors } = parseWithBabel(
    path,
    source,
    language,
  );
  const limitations =
    moduleOnlyErrors.length === 0
      ? []
      : [
          `Strict-mode errors apply only if this file is an ES module: ${moduleOnlyErrors.join("; ")}`,
        ];
  const parseFailures = reasons.map((reason) => ({
    path,
    parser: "babel",
    reason,
  }));

  if (ast === undefined) {
    return {
      relationships: [],
      parse_failures: parseFailures,
      limitations,
    };
  }

  const relationships: ReferenceSourceImportRelationship[] = [];
  extractImportDeclarations(ast.program.body, path, relationships, limitations);
  extractRequireAndDynamicImports(
    ast.program.body,
    path,
    relationships,
    limitations,
    referenceSourceRequireCalls(ast, path),
  );

  return {
    relationships: relationships.map((relationship) => ({
      ...relationship,
      parse_state:
        parseFailures.length > 0 && relationship.parse_state === "parsed"
          ? "partial"
          : relationship.parse_state,
    })),
    parse_failures: parseFailures,
    limitations,
  };
};
