import { access } from "node:fs/promises";
import { expect, it } from "vitest";
import { SourceMapDecoder } from "./SourceMapDecoder.js";
import { AnalysisCancelledError } from "../../domain/analysisErrorCore.js";
import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";
import {
  SourceMapCleanupFailure,
  type SourceMapDecoderDependencies,
} from "./SourceMapCommand.js";
import { PrivateRuntimeRoot } from "../../process/PrivateRuntimeRoot.js";
import { spawnOwnedProviderProcess } from "../../process/ProviderProcess.js";
import { cleanupOwnedProcessGroup } from "../../process/ProcessOwnership.js";
import {
  webSourceLocationArgs,
  webSourceLocationFixture,
} from "../../../tests/fixtures/webSourceLocation.js";

const fixture = webSourceLocationFixture();
const input = {
  text: fixture.sourceMap.text,
  url: fixture.sourceMap.url,
  path: fixture.sourceMap.file.path,
  position: webSourceLocationArgs.generated_position,
};

it("preserves the exact caller reason before source-map admission", async () => {
  const reason = { caller: "pre-aborted source-map decode" };
  const controller = new AbortController();
  controller.abort(reason);
  const response = await new SourceMapDecoder().trace(input, {
    signal: controller.signal,
  });
  expect(response.ok).toBe(false);
  if (response.ok) throw new Error("expected cancellation");
  expect(response.error).toBeInstanceOf(AnalysisCancelledError);
  expect(response.error.cause).toBe(reason);
});

it("retains failed cleanup ownership and retries it before another decode", async () => {
  const root = await PrivateRuntimeRoot.create({
    prefix: "rea-source-map-cleanup-retry-test-",
  });
  let cleanupAttempts = 0;
  const dependencies: SourceMapDecoderDependencies = {
    prepareOwnership: async () => {},
    createRuntime: async () => ({
      path: root.path,
      close: async () => {
        cleanupAttempts += 1;
        if (cleanupAttempts === 1)
          throw new Error("injected root cleanup failure");
        await root.close();
      },
    }),
    launcher: async (options) =>
      spawnOwnedProviderProcess({
        ...options,
        arguments: [
          "-e",
          'process.stderr.write("physical exit 7"); process.exit(7)',
        ],
      }),
  };
  const decoder = new SourceMapDecoder(dependencies);
  try {
    const failed = await decoder.trace(input);
    expect(failed.ok).toBe(false);
    if (failed.ok)
      throw new Error("expected physical failure with cleanup failure");
    expect(failed.error).toBeInstanceOf(SourceMapCleanupFailure);
    if (!(failed.error instanceof SourceMapCleanupFailure))
      throw new Error("expected source-map cleanup ownership");
    expect(failed.error.cleanupOwner).toBeDefined();
    expect(failed.error.cleanupResources).toEqual([root.path]);
    expect(failed.error.diagnostics).toMatchObject({
      cleanup_failures: ["injected root cleanup failure"],
    });
    expect(failed.error.diagnostics).toMatchObject({
      previous_error: expect.stringContaining(
        "source-map-decoder adapter failed",
      ),
    });
    await expect(access(root.path)).resolves.toBeUndefined();

    const invalidInput = { ...input, text: null } as unknown as typeof input;
    const retried = await decoder.trace(invalidInput);
    expect(retried.ok).toBe(false);
    if (retried.ok)
      throw new Error("expected invalid input after cleanup retry");
    expect(retried.error._tag).toBe("AnalysisInputError");
    expect(cleanupAttempts).toBe(2);
    await expect(access(root.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(failed.error.cleanupIncomplete).toBe(false);
    expect(failed.error.cleanupResources).toEqual([]);
    expect(projectAnalysisError(failed.error).code).not.toBe(
      "cleanup_incomplete",
    );
    expect(failed.error.diagnostics).toMatchObject({
      cleanup_failures: ["injected root cleanup failure"],
    });
  } finally {
    await decoder.close();
  }
});

it("settles every source-map cleanup failure when final close releases the exact runtime", async () => {
  const root = await PrivateRuntimeRoot.create({
    prefix: "rea-source-map-final-cleanup-test-",
  });
  let attempts = 0;
  const decoder = new SourceMapDecoder({
    prepareOwnership: async () => {},
    createRuntime: async () => ({
      path: root.path,
      close: async () => {
        attempts += 1;
        if (attempts <= 2)
          throw new Error(`runtime cleanup attempt ${String(attempts)} failed`);
        await root.close();
      },
    }),
    launcher: async () => {
      throw new Error("controlled launch failure");
    },
  });
  try {
    const initial = await decoder.trace(input);
    if (initial.ok) throw new Error("expected initial cleanup failure");
    const retry = await decoder.trace(input);
    if (retry.ok) throw new Error("expected retry cleanup failure");
    for (const failure of [initial.error, retry.error]) {
      expect(failure.cleanupIncomplete).toBe(true);
      expect(failure.cleanupResources).toEqual([root.path]);
    }
    await expect(access(root.path)).resolves.toBeUndefined();
    await decoder.close();
    expect(attempts).toBe(3);
    await expect(access(root.path)).rejects.toMatchObject({ code: "ENOENT" });
    for (const failure of [initial.error, retry.error]) {
      expect(failure.cleanupIncomplete).toBe(false);
      expect(failure.cleanupResources).toEqual([]);
      expect(projectAnalysisError(failure).code).not.toBe("cleanup_incomplete");
      expect(failure.diagnostics?.cleanup_failures).toEqual([
        expect.stringContaining("runtime cleanup attempt"),
      ]);
    }
  } finally {
    await decoder.close();
  }
});

it("attributes cleanup resources to the remaining process and directory owners", async () => {
  const root = await PrivateRuntimeRoot.create({
    prefix: "rea-source-map-mixed-cleanup-test-",
  });
  let denyProcessRelease = true;
  let rootAttempts = 0;
  let runId: string | undefined;
  const decoder = new SourceMapDecoder({
    prepareOwnership: async () => {},
    createRuntime: async () => ({
      path: root.path,
      close: async () => {
        rootAttempts += 1;
        if (rootAttempts === 1)
          throw new Error("controlled directory cleanup failure");
        await root.close();
      },
    }),
    launcher: async (options) => {
      runId = options.runId;
      const spawned = await spawnOwnedProviderProcess({
        ...options,
        arguments: ["-e", "process.exit(0)"],
      });
      return {
        ...spawned,
        cleanup: async () =>
          denyProcessRelease
            ? { cleaned: false, reason: "controlled process cleanup failure" }
            : spawned.cleanup === undefined
              ? cleanupOwnedProcessGroup(spawned.ownership)
              : spawned.cleanup(),
      };
    },
  });
  try {
    const initial = await decoder.trace(input);
    if (initial.ok) throw new Error("expected process cleanup failure");
    expect(initial.error.cleanupResources).toEqual([runId, root.path]);
    expect(rootAttempts).toBe(0);
    denyProcessRelease = false;
    await expect(decoder.close()).rejects.toMatchObject({
      cleanupIncomplete: true,
    });
    expect(rootAttempts).toBe(1);
    expect(initial.error.cleanupIncomplete).toBe(true);
    expect(initial.error.cleanupResources).toEqual([root.path]);
    await expect(access(root.path)).resolves.toBeUndefined();
    await decoder.close();
    expect(initial.error.cleanupIncomplete).toBe(false);
    expect(initial.error.cleanupResources).toEqual([]);
    await expect(access(root.path)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    denyProcessRelease = false;
    await decoder.close();
  }
});
