import type {
  JavaScriptSemanticResourceLimit,
  JavaScriptSemanticValue,
} from "./javascriptSemanticValueTypes.js";

export const SEMANTIC_PRIMITIVE_CANDIDATE_LIMIT = 256;
export const SEMANTIC_EXPRESSION_DEPTH_LIMIT = 256;

const RESOURCE_LIMIT_REASON: Record<JavaScriptSemanticResourceLimit, string> = {
  "primitive-candidates":
    "Primitive candidate budget exceeded (maximum 256 alternatives).",
  "expression-depth":
    "Semantic expression depth budget exceeded (maximum 256 nested expressions).",
};

/** Make an explicit unknown value tagged with the semantic resource bound. */
export const semanticResourceLimitUnknown = (
  resourceLimit: JavaScriptSemanticResourceLimit,
): JavaScriptSemanticValue => ({
  status: "unknown",
  reason: RESOURCE_LIMIT_REASON[resourceLimit],
  resourceLimit,
});

/** Collect resource-limit classifications from nested semantic values. */
export const semanticResourceLimitsIn = (
  values: readonly JavaScriptSemanticValue[],
): readonly JavaScriptSemanticResourceLimit[] => {
  const found = new Set<JavaScriptSemanticResourceLimit>();
  const pending = [...values];
  while (pending.length > 0) {
    const value = pending.pop();
    if (value === undefined) continue;
    if (value.status === "unknown" && value.resourceLimit !== undefined)
      found.add(value.resourceLimit);
    else if (value.status === "object")
      for (const property of value.properties) pending.push(property.value);
    else if (value.status === "array")
      for (const item of value.items) pending.push(item);
  }
  return [...found].sort();
};

/** Display label for one stable resource classification. */
export const semanticResourceLimitReason = (
  resourceLimit: JavaScriptSemanticResourceLimit,
): string => RESOURCE_LIMIT_REASON[resourceLimit];
