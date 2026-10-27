import type { JsonValue } from "../domain/jsonValue.js";
import type { Result } from "../domain/result.js";

/** Flatten a finalized outcome only when returning the command's JSON output. */
export const projectCliAnalysisResult = <Value>(
  result: Result<Value, JsonValue>,
): Value | JsonValue => (result.ok ? result.value : result.error);
