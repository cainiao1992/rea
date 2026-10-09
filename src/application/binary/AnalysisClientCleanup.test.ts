import { expect, it } from "vitest";

import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";
import { ProviderCleanupError } from "../../domain/providerCleanupError.js";
import { err } from "../../domain/result.js";
import type { AnalysisClient } from "../AnalysisProvider.js";
import { closeAnalysisClient } from "./AnalysisClientCleanup.js";

const clientClosingWith = (cause: unknown): AnalysisClient => ({
  execute: () => Promise.resolve(err(new ProviderCleanupError("x", [], {}))),
  close: () => Promise.reject(cause),
});

it("keeps the leftover resources a typed cleanup failure names", async () => {
  const leftover = "/tmp/rea-ghidra-fixture";
  const failure = new ProviderCleanupError("ghidra", [leftover], {
    reason: "runtime directory retained",
  });

  const closed = await closeAnalysisClient(
    clientClosingWith(failure),
    "ghidra",
  );

  expect(closed.ok).toBe(false);
  if (!closed.ok)
    expect(projectAnalysisError(closed.error)).toMatchObject({
      code: "cleanup_incomplete",
      details: { resources: [leftover] },
    });
});

it("still reports an untyped close rejection as the provider client", async () => {
  const closed = await closeAnalysisClient(
    clientClosingWith(new Error("unexpected")),
    "ghidra",
  );

  expect(closed.ok).toBe(false);
  if (!closed.ok)
    expect(projectAnalysisError(closed.error)).toMatchObject({
      code: "cleanup_incomplete",
      details: { resources: ["provider-client"] },
    });
});
