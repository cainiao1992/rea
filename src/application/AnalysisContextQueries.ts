import type {
  AnalysisExecution,
  AnalysisOperation,
  AnalysisOperationPort,
} from "./AnalysisProvider.js";
import type { AnalysisError } from "../domain/errors.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { ok, type Result } from "../domain/result.js";

type Facet =
  | { readonly state: "available"; readonly value: JsonValue }
  | {
      readonly state: "unavailable";
      readonly reason: string;
      readonly remediation: string;
    };

const parameters = (
  document: string | undefined,
  address?: string,
): Readonly<Record<string, JsonValue>> => ({
  ...(document === undefined ? {} : { document }),
  ...(address === undefined ? {} : { address }),
});

const executionOptions = (
  signal: AbortSignal | undefined,
): { readonly signal?: AbortSignal } =>
  signal === undefined ? {} : { signal };

/** Compose the provider's volatile selection state into one coherent query. */
export const getNavigationContext = async (
  analysis: AnalysisOperationPort,
  input: { readonly document?: string | undefined },
  signal?: AbortSignal,
): Promise<Result<JsonValue, AnalysisError>> => {
  const args = parameters(input.document);
  const [document, address, procedure] = await Promise.all([
    input.document === undefined
      ? analysis.execute("current_document", {}, executionOptions(signal))
      : Promise.resolve(input.document),
    analysis.execute("current_address", args, executionOptions(signal)),
    analysis.execute("current_procedure", args, executionOptions(signal)),
  ]);
  if (typeof document !== "string" && !document.ok) return document;
  if (!address.ok) return address;
  if (!procedure.ok && !isMissingCurrentProcedure(procedure.error))
    return procedure;
  return ok({
    document: typeof document === "string" ? document : document.value.result,
    address: address.value.result,
    procedure: procedure.ok ? procedure.value.result : null,
  });
};

/** Inspect bounded provider-neutral facets at one explicit reproducible address. */
export const inspectAddressContext = async (
  analysis: AnalysisOperationPort,
  input: { readonly address: string; readonly document?: string | undefined },
  signal?: AbortSignal,
): Promise<Result<JsonValue, AnalysisError>> => {
  const args = parameters(input.document, input.address);
  const operations = [
    "address_name",
    "resolve_containing_procedure",
    "comment",
    "inline_comment",
    "list_bookmarks",
  ] as const satisfies readonly AnalysisOperation[];
  const results = await Promise.all(
    operations.map((operation) =>
      analysis.execute(
        operation,
        operation === "list_bookmarks" ? parameters(input.document) : args,
        executionOptions(signal),
      ),
    ),
  );
  const name = facet(results[0], operations[0]);
  const procedure = facet(results[1], operations[1]);
  const comment = facet(results[2], operations[2]);
  const inlineComment = facet(results[3], operations[3]);
  const bookmarks = facet(results[4], operations[4]);
  return ok({
    address: input.address,
    document: input.document ?? null,
    name,
    procedure,
    comment,
    inline_comment: inlineComment,
    bookmarks:
      bookmarks.state === "available"
        ? {
            state: "available",
            value: matchingBookmarks(bookmarks.value, input.address),
          }
        : bookmarks,
  });
};

const facet = (
  result: Result<AnalysisExecution, AnalysisError> | undefined,
  operation: AnalysisOperation,
): Facet =>
  result?.ok === true
    ? { state: "available", value: result.value.result }
    : {
        state: "unavailable",
        reason: result?.error.message ?? `${operation} returned no result`,
        remediation: `Call ${operation} directly to inspect provider availability and diagnostics.`,
      };

const isMissingCurrentProcedure = (error: AnalysisError): boolean =>
  /(?:no procedure exists|not in a procedure)/iu.test(error.message);

const matchingBookmarks = (value: JsonValue, address: string): JsonValue => {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (bookmark) =>
      typeof bookmark === "object" &&
      bookmark !== null &&
      !Array.isArray(bookmark) &&
      bookmark.address === address,
  );
};
