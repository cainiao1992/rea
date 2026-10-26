import { z } from "zod";
import { ok, type Result } from "../result.js";
import { AnalysisOutputError } from "../analysisErrorCore.js";
import type { JsonValue } from "../jsonValue.js";
import {
  unwrapNativeProperty,
  invalidNativeOutput,
} from "./nativeProviderOutput.js";

/** Parse direct or wrapped provider document names. */
export const parseDocuments = (
  value: JsonValue,
  operation = "list_documents",
): Result<readonly string[], AnalysisOutputError> => {
  const parsed = z
    .array(z.string())
    .safeParse(unwrapNativeProperty(value, "documents"));
  return parsed.success
    ? ok(parsed.data)
    : invalidNativeOutput(operation, "document list", parsed.error);
};
