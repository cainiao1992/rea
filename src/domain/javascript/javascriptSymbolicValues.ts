import type * as t from "@babel/types";

/** A lexical substitution environment, never a JavaScript execution context. */
export interface SymbolicEnvironment {
  readonly values: ReadonlyMap<string, SymbolicValue>;
  readonly parent?: SymbolicEnvironment;
}

export interface SymbolicFunction {
  readonly kind: "function";
  readonly node: t.Function;
  readonly environment: SymbolicEnvironment;
  readonly origins: readonly t.Node[];
}

export type SymbolicValue =
  | { readonly kind: "unknown"; readonly reason: string }
  | {
      readonly kind: "literal";
      readonly value: string | number | boolean | null | undefined;
    }
  | { readonly kind: "external"; readonly path: readonly string[] }
  | {
      readonly kind: "object";
      readonly node: t.ObjectExpression;
      readonly environment: SymbolicEnvironment;
    }
  | {
      readonly kind: "namespace";
      readonly bindingId: string;
      readonly environment: SymbolicEnvironment;
    }
  | {
      readonly kind: "loader";
      readonly modules: ReadonlyMap<string, SymbolicValue>;
    }
  | { readonly kind: "array"; readonly values: readonly SymbolicValue[] }
  | {
      readonly kind: "record";
      readonly values: ReadonlyMap<string, SymbolicValue>;
    }
  | { readonly kind: "union"; readonly values: readonly SymbolicValue[] }
  | SymbolicFunction;

export const symbolicUnknown = (reason: string): SymbolicValue => ({
  kind: "unknown",
  reason,
});
export const symbolicVariants = (
  value: SymbolicValue,
): readonly SymbolicValue[] =>
  value.kind === "union" ? value.values : [value];
export const symbolicUnion = (
  values: readonly SymbolicValue[],
): SymbolicValue => {
  const unique = [...new Set(values.flatMap(symbolicVariants))];
  return unique.length === 1 ? unique[0]! : { kind: "union", values: unique };
};
export const symbolicTruth = (value: SymbolicValue): boolean | undefined =>
  value.kind === "literal"
    ? Boolean(value.value)
    : ["function", "object", "namespace", "array"].includes(value.kind)
      ? true
      : undefined;
