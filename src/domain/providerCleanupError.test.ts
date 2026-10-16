import { expect, it } from "vitest";
import { ProviderCleanupError } from "./providerCleanupError.js";
import { projectAnalysisError } from "./analysisErrorProjection.js";
import { analysisErrorWithCleanupFailure } from "./analysisErrorCleanup.js";
it("preserves the binary cleanup default and an explicitly owned nonbinary operation", () => {
  expect(new ProviderCleanupError("ghidra", ["database"], {}).operation).toBe(
    "close_binary",
  );
  const error = new ProviderCleanupError(
    "source-map-decoder",
    ["runtime"],
    { reason: "cleanup failed" },
    { operation: "trace_web_source_location" },
  );
  expect(error.operation).toBe("trace_web_source_location");
  expect(projectAnalysisError(error)).toMatchObject({
    code: "cleanup_incomplete",
    details: { operation: "trace_web_source_location" },
  });
});

it.each([false, true])(
  "reports only live primary resources after cleanup recovery is %s",
  (recovered) => {
    const primary = new ProviderCleanupError("adb", ["descriptor"], {
      reason: "descriptor close failed",
    });
    if (recovered) primary.resolveCleanup();
    const cleanup = new ProviderCleanupError("adb", ["runtime-root"], {
      reason: "root removal failed",
    });
    const combined = analysisErrorWithCleanupFailure(primary, cleanup);
    expect(combined.cleanupResources).toEqual(
      recovered ? ["runtime-root"] : ["descriptor", "runtime-root"],
    );
    expect(projectAnalysisError(combined)).toMatchObject({
      code: "cleanup_incomplete",
      details: {
        diagnostics: {
          primary_error: {
            details: { diagnostics: { reason: "descriptor close failed" } },
          },
          cleanup_error: {
            details: { diagnostics: { reason: "root removal failed" } },
          },
        },
      },
    });
    expect(combined.cause).toBeInstanceOf(AggregateError);
    expect((combined.cause as AggregateError).errors).toEqual([
      primary,
      cleanup,
    ]);
  },
);
