import { z } from "zod";
import { err, type Result } from "../result.js";
import { AnalysisOutputError } from "../analysisErrorCore.js";
import type { JsonValue } from "../jsonValue.js";

export const unwrapNativeProperty = (
  value: JsonValue,
  property: string,
): JsonValue => {
  if (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    property in value
  ) {
    return value[property] ?? null;
  }
  return value;
};

export const invalidNativeOutput = <T>(
  operation: string,
  expected: string,
  cause: z.ZodError,
): Result<T, AnalysisOutputError> =>
  err(
    new AnalysisOutputError(
      operation,
      `Provider returned an invalid ${expected}`,
      {
        cause,
      },
    ),
  );
