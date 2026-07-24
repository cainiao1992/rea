import type { AnalysisOperation } from "./AnalysisProvider.js";
import { AnalysisOutputError, type AnalysisError } from "../domain/errors.js";
import { parseAddressedPage } from "../domain/hopperValues.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { err, ok, type Result } from "../domain/result.js";
import type {
  EnhancedResult,
  TraceMatch,
  TraceReference,
} from "./EnhancedToolTypes.js";

type AnalysisCall = (
  name: AnalysisOperation,
  arguments_: Readonly<Record<string, JsonValue>>,
  signal?: AbortSignal,
) => Promise<Result<JsonValue, AnalysisError>>;

type LiteralSearchSource = readonly [
  "list_strings" | "list_procedures",
  "string" | "procedure",
];

interface ReferenceTraceRequest {
  readonly matches: readonly TraceMatch[];
  readonly limit: number;
  readonly operationBudget: number;
  readonly signal?: AbortSignal;
}

const FEATURE_SEARCH_SOURCES: readonly LiteralSearchSource[] = [
  ["list_strings", "string"],
  ["list_procedures", "procedure"],
];
const STRING_SEARCH_SOURCES: readonly LiteralSearchSource[] = [
  ["list_strings", "string"],
];

export interface LiteralTraceInput {
  readonly query: string;
  readonly case_sensitive: boolean;
  readonly limit: number;
  readonly max_operations: number;
}

/** Trace a bounded feature or string literal through provider xrefs. */
export const traceLiteralFeature = async (
  call: AnalysisCall,
  input: LiteralTraceInput,
  scope: "feature" | "string",
  signal?: AbortSignal,
): EnhancedResult => {
  const sources =
    scope === "feature" ? FEATURE_SEARCH_SOURCES : STRING_SEARCH_SOURCES;
  const searched = await literalMatches(call, input, sources, signal);
  if (!searched.ok) return searched;
  const residual = new Set<string>();
  const traced = await traceReferences(call, {
    matches: searched.value.matches,
    limit: input.limit,
    operationBudget: input.max_operations - searched.value.operations,
    ...(signal === undefined ? {} : { signal }),
  });
  if (!traced.ok) return traced;
  for (const reason of traced.value.residual) residual.add(reason);
  const operations = searched.value.operations + traced.value.operations;
  if (operations >= input.max_operations)
    residual.add("Investigation reached the operation budget.");
  if (searched.value.matches.length >= input.limit)
    residual.add("Literal matches reached the configured limit.");
  return ok({
    query: input.query,
    search_mode: "literal",
    operations_used: operations,
    operation_budget: input.max_operations,
    matches: searched.value.matches,
    references: traced.value.references,
    truncated: residual.size > 0,
    residual_unknowns: [...residual],
  });
};

const literalMatches = async (
  call: AnalysisCall,
  input: LiteralTraceInput,
  sources: readonly LiteralSearchSource[],
  signal?: AbortSignal,
): Promise<
  Result<{ matches: TraceMatch[]; operations: number }, AnalysisError>
> => {
  let operations = 0;
  const matches: TraceMatch[] = [];
  const needle = input.case_sensitive ? input.query : input.query.toLowerCase();
  for (const [tool, type] of sources) {
    let offset = 0;
    while (operations < input.max_operations && matches.length < input.limit) {
      operations += 1;
      const result = await call(tool, { offset, limit: 500 }, signal);
      if (!result.ok) return result;
      const page = parseAddressedPage(result.value);
      if (!page.ok) return page;
      for (const item of page.value.items) {
        const haystack = input.case_sensitive
          ? item.name
          : item.name.toLowerCase();
        if (haystack.includes(needle))
          matches.push({ type, address: item.address, value: item.name });
        if (matches.length >= input.limit) break;
      }
      if (!page.value.hasMore || page.value.nextOffset === null) break;
      offset = page.value.nextOffset;
    }
  }
  return ok({ matches, operations });
};

const traceReferences = async (
  call: AnalysisCall,
  request: ReferenceTraceRequest,
): Promise<
  Result<
    { references: TraceReference[]; operations: number; residual: string[] },
    AnalysisError
  >
> => {
  let operations = 0;
  const references: TraceReference[] = [];
  const residual = new Set<string>();
  for (const match of request.matches) {
    if (operations >= request.operationBudget) {
      residual.add("Reference traversal stopped at the operation budget.");
      break;
    }
    operations += 1;
    const xrefs = await call(
      "xrefs",
      { address: match.address },
      request.signal,
    );
    if (!xrefs.ok) return xrefs;
    if (!Array.isArray(xrefs.value))
      return err(
        new AnalysisOutputError(
          "xrefs",
          "provider returned a non-array result",
        ),
      );
    for (const source of xrefs.value) {
      if (typeof source !== "string")
        return err(
          new AnalysisOutputError(
            "xrefs",
            "provider returned a non-address value",
          ),
        );
      if (operations >= request.operationBudget) {
        residual.add(
          "Containing-procedure resolution stopped at the operation budget.",
        );
        break;
      }
      operations += 1;
      const resolved = await call(
        "resolve_containing_procedure",
        { address: source },
        request.signal,
      );
      if (!resolved.ok) return resolved;
      references.push({
        target_address: match.address,
        source_address: source,
        containing_procedure: resolved.value,
      });
      if (references.length >= request.limit) {
        residual.add("Reference results reached the configured limit.");
        break;
      }
    }
    if (references.length >= request.limit) break;
  }
  return ok({
    references,
    operations,
    residual: [...residual],
  });
};
