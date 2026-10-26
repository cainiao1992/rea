import { JsonSchemaReferences } from "../../src/contracts/jsonSchemaReferences.js";
import {
  schemaArrays,
  schemaChildren,
  schemaMaps,
} from "../../src/contracts/jsonSchemaKeywords.js";

const isSchemaObject = (
  value: unknown,
): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Check forwarded regex constraints in native plain/Unicode/Unicode-sets modes. */
export const assertClientSchemaPatterns = (
  schema: unknown,
): readonly string[] => {
  if (!isSchemaObject(schema)) return [];
  const patterns: string[] = [];
  const seen = new Set<object>();
  const checkPattern = (pattern: string): void => {
    for (const flags of ["", "u", "v"]) new RegExp(pattern, flags);
    patterns.push(pattern);
  };
  const visit = (value: unknown): void => {
    if (!isSchemaObject(value) || seen.has(value)) return;
    seen.add(value);
    for (const [key, child] of Object.entries(value)) {
      if (key === "pattern" && typeof child === "string") checkPattern(child);
      else if (schemaMaps.has(key) && isSchemaObject(child)) {
        for (const [name, nested] of Object.entries(child)) {
          if (key === "patternProperties") checkPattern(name);
          visit(nested);
        }
      } else if (
        (schemaArrays.has(key) || schemaChildren.has(key)) &&
        Array.isArray(child)
      ) {
        for (const nested of child) visit(nested);
      } else if (schemaChildren.has(key)) visit(child);
    }
  };
  visit(schema);
  // Literal instance values stay opaque unless the reference owner resolves a
  // local target into them. External/dynamic/ambiguous targets remain unknown.
  for (const { target } of new JsonSchemaReferences(schema).references())
    if (target.kind === "target") visit(target.value);
  return patterns;
};
