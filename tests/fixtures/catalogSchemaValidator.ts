import type {
  JsonSchemaType,
  jsonSchemaValidator,
} from "@modelcontextprotocol/client";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";
import { canonicalJson } from "../../src/domain/comparisonSemantics.js";

/**
 * Share the SDK's default compiler for this fixture's finite catalog only.
 * Full documents (including dialect) admit reuse; the SDK owns compilation
 * and its $id cache. Other documents get an isolated default SDK compiler so
 * a changed schema cannot inherit an earlier validator for the same $id.
 * The caller owns this provider's lifetime, including the compiled catalog.
 */
export const createCatalogSchemaValidator = (
  schemas: readonly Readonly<Record<string, unknown>>[],
): jsonSchemaValidator => {
  const documents = new Map<string, string>();
  for (const schema of schemas) {
    if (typeof schema.$id !== "string") continue;
    const document = canonicalJson(schema, "Fixture output schema");
    const previous = documents.get(schema.$id);
    if (previous !== undefined && previous !== document)
      throw new TypeError(
        "Fixture output schemas reuse an id for different documents",
      );
    documents.set(schema.$id, document);
  }
  const expected = new Set(documents.values());
  const compiler = new AjvJsonSchemaValidator();
  return {
    getValidator<T>(schema: JsonSchemaType) {
      const delegate = expected.has(canonicalJson(schema, "Tool output schema"))
        ? compiler
        : new AjvJsonSchemaValidator();
      return delegate.getValidator<T>(schema);
    },
  };
};
