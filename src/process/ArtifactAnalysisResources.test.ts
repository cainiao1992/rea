import { OwnedCommandFailure } from "./OwnedCommand.js";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { expect, it } from "vitest";
import { readStableArtifact } from "../artifacts/readStableArtifact.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import {
  AnalysisCancelledError,
  AnalysisOutputError,
} from "../domain/analysisErrorCore.js";
import { createEvidence } from "../domain/evidence.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { err, ok } from "../domain/result.js";
import { ArtifactAnalysisResources } from "./ArtifactAnalysisResources.js";
import { readLinuxResourceLimits } from "./LinuxResourceLimits.js";
import { ProviderProcessSupervisor } from "./ProviderProcess.js";

it("projects the specific reason and member evidence for retained cleanup", async () => {
  const producer = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
    kill: () => true,
  });
  const owner = new ProviderProcessSupervisor({
    process: producer,
    ownsProcessLifetime: true,
    ownership: {
      runId: "rea-tshark-run-1",
      leaderPid: 4242,
      processGroupId: 4242,
    },
    cleanup: async () => ({
      cleaned: false as const,
      reason: "process ownership token could not be read for 1 live process",
      failures: [
        {
          pid: 101,
          reason: "environment-unreadable" as const,
          diagnostic: "sysctl_errno_22",
        },
      ],
      unverified: [
        { pid: 900, diagnostic: "platform_binary_environment_withheld" },
      ],
    }),
  });
  const resources = new ArtifactAnalysisResources(
    "fixture-provider",
    "fixture-operation",
    readStableArtifact,
    readLinuxResourceLimits,
    { message: "busy", details: {} },
  );
  resources.retain({ path: "runtime-root", close: async () => {} }, owner);

  const result = await resources.finish(
    err(new ProviderAdapterError("fixture-provider", "fixture-operation")),
    () => {
      throw new Error("unexpected success observation");
    },
  );
  owner.dispose();

  if (result.ok) throw new Error("expected cleanup failure");
  expect(projectAnalysisError(result.error)).toMatchObject({
    code: "cleanup_incomplete",
    details: {
      resources: [
        "rea-tshark-run-1",
        "runtime-root",
        "pid:4242",
        "process-group:4242",
      ],
      diagnostics: {
        reason: "process ownership token could not be read for 1 live process",
        failures: [
          {
            pid: 101,
            reason: "environment-unreadable",
            diagnostic: "sysctl_errno_22",
          },
        ],
        unverified: [
          { pid: 900, diagnostic: "platform_binary_environment_withheld" },
        ],
      },
    },
  });
});

it("preserves the primary error and resolves cleanup status after retry", async () => {
  let closes = 0;
  const resources = new ArtifactAnalysisResources(
    "fixture-provider",
    "fixture-operation",
    readStableArtifact,
    readLinuxResourceLimits,
    { message: "busy", details: {} },
  );
  resources.retain({
    path: "runtime-root",
    close: async () => {
      closes++;
      if (closes === 1) throw new Error("temporary close failure");
    },
  });
  const primary = new AnalysisOutputError(
    "fixture-operation",
    "producer returned malformed output",
    {
      partialObservation: createEvidence(
        undefined,
        {
          id: "fixture",
          name: "Fixture",
          version: null,
        },
        {
          operation: "inspect_signal_decoders",
          parameters: {},
          result: { decoders: [] },
          confidence: "observed",
        },
      ),
    },
  );

  const result = await resources.finish(err(primary), () => {
    throw new Error("unexpected success observation");
  });

  if (result.ok) throw new Error("expected cleanup failure");
  expect(result.error.cause).toBeInstanceOf(AggregateError);
  expect((result.error.cause as AggregateError).errors).toEqual([
    primary,
    expect.any(ProviderCleanupError),
  ]);
  expect(result.error.partialObservation).toEqual(primary.partialObservation);
  expect(result.error.cleanupIncomplete).toBe(true);
  expect(result.error.diagnostics).toMatchObject({
    previous_error: { code: "unreadable_output" },
  });

  await resources.release();

  expect(result.error.cleanupIncomplete).toBe(false);
  expect(closes).toBe(2);
  await resources.close();
});

it("resolves each returned cleanup error with its own retained root", async () => {
  let closesA = 0;
  let closesB = 0;
  const resources = new ArtifactAnalysisResources(
    "fixture-provider",
    "fixture-operation",
    readStableArtifact,
    readLinuxResourceLimits,
    { message: "busy", details: {} },
  );
  resources.retain({
    path: "runtime-root-a",
    close: async () => {
      closesA++;
      if (closesA === 1) throw new Error("root A close failure");
    },
  });
  const first = await resources.finish(
    err(new AnalysisOutputError("fixture-operation", "primary failure")),
    () => {
      throw new Error("unexpected success observation");
    },
  );
  if (first.ok) throw new Error("expected root A cleanup failure");

  resources.retain({
    path: "runtime-root-b",
    close: async () => {
      closesB++;
      if (closesB === 1) throw new Error("root B close failure");
    },
  });
  const partial = createEvidence(
    undefined,
    { id: "fixture", name: "Fixture", version: null },
    {
      operation: "fixture-operation",
      parameters: {},
      result: { state: "partial" },
      confidence: "observed",
    },
  );
  const second = await resources.finish(ok("completed"), () => partial);

  if (second.ok) throw new Error("expected root B cleanup failure");
  expect(second.error.partialObservation).toEqual(partial);
  expect(first.error.cleanupIncomplete).toBe(false);
  expect(second.error.cleanupIncomplete).toBe(true);

  await resources.release();
  expect(second.error.cleanupIncomplete).toBe(false);
  await resources.close();
});

it("resolves an artifact cleanup error when its scope owner later closes", async () => {
  let closes = 0;
  const readArtifact: typeof readStableArtifact = async (
    _path,
    _maximumBytes,
    _signal,
    _fileSystem,
    scope,
  ) => {
    if (scope === undefined) throw new Error("expected scoped artifact read");
    if (closes === 0) {
      const owner = {
        kind: "lease",
        resource: "fixture descriptor",
        lease: {
          release: async () => {
            closes++;
            if (closes === 1) throw new Error("descriptor remains open");
          },
        },
      } as const;
      expect(await scope.release(owner)).toMatchObject({ kind: "failed" });
      throw new ArtifactReaderFailure("io", "Descriptor close failed", {
        cleanup: {
          reason: "descriptor remains open",
          resources: ["fixture descriptor"],
        },
      });
    }
    return { bytes: Buffer.alloc(0), sha256: "0".repeat(64) };
  };
  const resources = new ArtifactAnalysisResources(
    "fixture-provider",
    "fixture-operation",
    readArtifact,
    readLinuxResourceLimits,
    { message: "busy", details: {} },
  );
  const first = await resources.run(async () =>
    ok(await resources.read("fixture", 1)),
  );

  if (first.ok) throw new Error("expected descriptor cleanup failure");
  expect(first.error.cleanupIncomplete).toBe(true);

  const retried = await resources.run(async () =>
    ok(await resources.read("fixture", 1)),
  );

  expect(retried.ok).toBe(true);
  expect(first.error.cleanupIncomplete).toBe(false);
  expect(closes).toBe(2);
  await resources.close();
});

it("keeps a runtime root until its descriptor cleanup owner is released", async () => {
  let descriptorCloses = 0;
  let rootCloses = 0;
  const readArtifact: typeof readStableArtifact = async (
    _path,
    _maximumBytes,
    _signal,
    _fileSystem,
    scope,
  ) => {
    if (scope === undefined) throw new Error("expected scoped artifact read");
    if (descriptorCloses === 0) {
      const owner = {
        kind: "lease",
        resource: "fixture descriptor",
        lease: {
          release: async () => {
            descriptorCloses++;
            if (descriptorCloses === 1)
              throw new Error("descriptor remains open");
          },
        },
      } as const;
      expect(await scope.release(owner)).toMatchObject({ kind: "failed" });
      throw new ArtifactReaderFailure("io", "Descriptor close failed", {
        cleanup: {
          reason: "descriptor remains open",
          resources: ["fixture descriptor"],
        },
      });
    }
    return { bytes: Buffer.alloc(0), sha256: "0".repeat(64) };
  };
  const resources = new ArtifactAnalysisResources(
    "fixture-provider",
    "fixture-operation",
    readArtifact,
    readLinuxResourceLimits,
    { message: "busy", details: {} },
  );
  const first = await resources.run(async () =>
    ok(await resources.read("fixture", 1)),
  );
  if (first.ok) throw new Error("expected descriptor cleanup failure");
  resources.retain({
    path: "runtime-root",
    close: async () => {
      rootCloses++;
    },
  });

  const outer = await resources.finish(first, () => {
    throw new Error("unexpected success observation");
  });

  if (outer.ok) throw new Error("expected combined cleanup failure");
  expect(rootCloses).toBe(0);
  expect(outer.error.cleanupResources).toEqual([
    "fixture descriptor",
    "runtime-root",
  ]);
  expect(outer.error.cause).toBeInstanceOf(AggregateError);
  expect((outer.error.cause as AggregateError).errors[0]).toBe(first.error);
  expect(first.error.cleanupIncomplete).toBe(true);

  const retried = await resources.run(async () =>
    ok(await resources.read("fixture", 1)),
  );
  expect(retried.ok).toBe(true);
  expect(first.error.cleanupIncomplete).toBe(false);
  await resources.release();
  expect(rootCloses).toBe(1);
  expect(outer.error.cleanupIncomplete).toBe(false);
  await resources.close();
});

it.each([
  null,
  "opaque reason",
  new ProviderCleanupError("foreign", ["foreign-resource"], {
    reason: "caller cleanup",
  }),
])(
  "preserves caller cancellation at resource admission: %s",
  async (reason) => {
    const resources = new ArtifactAnalysisResources(
      "fixture",
      "inspect_signal_decoders",
      readStableArtifact,
      readLinuxResourceLimits,
      { message: "busy", details: {} },
    );
    let calls = 0;
    try {
      const result = await resources.run(async () => {
        calls++;
        return ok("unexpected");
      }, AbortSignal.abort(reason));
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Expected cancelled admission");
      expect(result.error.cause).toBe(reason);
      expect(result.error.cleanupResources).toEqual([]);
      expect(calls).toBe(0);
      if (reason instanceof ProviderCleanupError)
        expect(reason.cleanupIncomplete).toBe(true);
    } finally {
      await resources.close();
    }
  },
);

it.each([
  null,
  "opaque reason",
  new ProviderCleanupError("foreign", ["foreign-resource"], {
    reason: "caller cleanup",
  }),
])(
  "projects the command owner's exact cancellation independently of physical causes: %s",
  async (reason) => {
    const resources = new ArtifactAnalysisResources(
      "fixture",
      "inspect_signal_decoders",
      readStableArtifact,
      readLinuxResourceLimits,
      { message: "busy", details: {} },
    );
    const physical = new Error("physical collection interruption");
    const failure = new OwnedCommandFailure(
      "cancelled",
      "cancelled command",
      null,
      null,
      { cause: physical, cancellation: { reason } },
    );
    try {
      const error = resources.commandFailure(
        failure,
        { command_timeout_ms: 100, output_bytes: 1024 },
        undefined,
      );
      expect(error).toMatchObject({ _tag: "AnalysisCancelledError" });
      expect(error.cause).toBe(reason);
      expect(error.cleanupResources).toEqual([]);
      expect(failure.cause).toBe(physical);
      if (reason instanceof ProviderCleanupError)
        expect(reason.cleanupIncomplete).toBe(true);
    } finally {
      await resources.close();
    }
  },
);

it.each([false, true])(
  "preserves artifact cancellation and independent failed cleanup (failed close: %s)",
  async (failedClose) => {
    const reason = { request: "artifact cancellation" };
    let mayClose = false;
    const readArtifact: typeof readStableArtifact = async (
      _path,
      _limit,
      _signal,
      _fs,
      scope,
    ) => {
      if (failedClose) {
        if (scope === undefined)
          throw new Error("Expected retained file scope");
        const retained = {
          kind: "lease",
          resource: "descriptor",
          lease: {
            release: async () => {
              if (!mayClose)
                throw new Error("injected descriptor close failure");
            },
          },
        } as const;
        expect(await scope.release(retained)).toMatchObject({ kind: "failed" });
      }
      throw new ArtifactReaderFailure("cancelled", "read cancelled", {
        cause: reason,
        ...(failedClose
          ? {
              cleanup: {
                reason: "injected descriptor close failure",
                resources: ["descriptor"],
              },
            }
          : {}),
      });
    };
    const resources = new ArtifactAnalysisResources(
      "fixture",
      "inspect_signal_decoders",
      readArtifact,
      readLinuxResourceLimits,
      { message: "busy", details: {} },
    );
    try {
      const result = await resources.run(async () =>
        ok(await resources.read("fixture", 1)),
      );
      if (result.ok) throw new Error("Expected cancelled artifact read");
      const primary = failedClose ? result.error.cleanupPrimary : result.error;
      expect(primary).toMatchObject({ _tag: "AnalysisCancelledError" });
      expect(primary?.cause).toBe(reason);
      expect(result.error.cleanupIncomplete).toBe(failedClose);
      mayClose = true;
      await resources.close();
      expect(result.error.cleanupIncomplete).toBe(false);
      expect(primary?.cause).toBe(reason);
    } finally {
      mayClose = true;
      await resources.close();
    }
  },
);

it("retains a physical command failure when the owner also observed late cancellation", async () => {
  const resources = new ArtifactAnalysisResources(
    "fixture",
    "inspect_signal_decoders",
    readStableArtifact,
    readLinuxResourceLimits,
    { message: "busy", details: {} },
  );
  const reason = { request: "late cancellation" };
  const failure = new OwnedCommandFailure(
    "process",
    "physical failure",
    null,
    null,
    { cancellation: { reason } },
  );
  try {
    const error = resources.commandFailure(
      failure,
      { command_timeout_ms: 100, output_bytes: 1024 },
      undefined,
    );
    expect(error).toMatchObject({ _tag: "AnalysisOutputError" });
    expect(error.cause).toBe(failure);
  } finally {
    await resources.close();
  }
});

it("preserves typed caller cancellation through failed workspace cleanup and retry", async () => {
  let denied = true;
  const resources = new ArtifactAnalysisResources(
    "fixture",
    "inspect_signal_decoders",
    readStableArtifact,
    readLinuxResourceLimits,
    { message: "busy", details: {} },
  );
  const reason = { request: "cancelled before workspace cleanup" };
  const primary = new AnalysisCancelledError("inspect_signal_decoders", {
    cause: reason,
  });
  resources.retain({
    path: "workspace",
    close: async () => {
      if (denied) throw new Error("workspace close denied");
    },
  });
  try {
    const result = await resources.finish(err(primary), () => {
      throw new Error("Must not produce success Evidence");
    });
    if (result.ok) throw new Error("Expected retained workspace");
    expect(result.error.cleanupPrimary).toBe(primary);
    expect(result.error.cleanupPrimary?.cause).toBe(reason);
    await expect(resources.close()).rejects.toMatchObject({
      cleanupIncomplete: true,
    });
    denied = false;
    await resources.close();
    expect(result.error.cleanupIncomplete).toBe(false);
    expect(result.error.cleanupPrimary?.cause).toBe(reason);
  } finally {
    denied = false;
    await resources.close();
  }
});

it("observes cancellation after pending descriptor cleanup before admitting replacement work", async () => {
  let closes = 0;
  let cleanupStarted: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    cleanupStarted = resolve;
  });
  let releaseCleanup: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    releaseCleanup = resolve;
  });
  const readArtifact: typeof readStableArtifact = async (
    _path,
    _limit,
    _signal,
    _fs,
    scope,
  ) => {
    if (scope === undefined) throw new Error("Expected file scope");
    const retained = {
      kind: "lease",
      resource: "descriptor",
      lease: {
        release: async () => {
          closes++;
          if (closes === 1) throw new Error("descriptor close denied");
          cleanupStarted();
          await held;
        },
      },
    } as const;
    await scope.release(retained);
    throw new ArtifactReaderFailure("io", "descriptor cleanup failed", {
      cleanup: { reason: "descriptor close denied", resources: ["descriptor"] },
    });
  };
  const resources = new ArtifactAnalysisResources(
    "fixture",
    "inspect_signal_decoders",
    readArtifact,
    readLinuxResourceLimits,
    { message: "busy", details: {} },
  );
  let calls = 0;
  try {
    const first = await resources.run(async () =>
      ok(await resources.read("fixture", 1)),
    );
    expect(first).toMatchObject({
      ok: false,
      error: { cleanupIncomplete: true },
    });
    const caller = new AbortController();
    const reason = { request: "cancel while old descriptor closes" };
    const pending = resources.run(async () => {
      calls++;
      return ok("Must not run");
    }, caller.signal);
    await started;
    caller.abort(reason);
    releaseCleanup();
    const result = await pending;
    if (result.ok) throw new Error("Expected cancelled replacement");
    expect(result.error.cause).toBe(reason);
    expect(calls).toBe(0);
    if (!first.ok) expect(first.error.cleanupIncomplete).toBe(false);
  } finally {
    releaseCleanup();
    await resources.close();
  }
});

it.each([false, true])(
  "keeps an existing physical primary across cleanup-time cancellation (failed close: %s)",
  async (failsClose) => {
    const resources = new ArtifactAnalysisResources(
      "fixture",
      "inspect_signal_decoders",
      readStableArtifact,
      readLinuxResourceLimits,
      { message: "busy", details: {} },
    );
    const caller = new AbortController();
    const primary = new AnalysisOutputError(
      "inspect_signal_decoders",
      "physical producer report failure",
    );
    let denied = failsClose;
    resources.retain({
      path: "workspace",
      close: async () => {
        caller.abort({ request: "late cancellation" });
        if (denied) throw new Error("workspace close denied");
      },
    });
    try {
      const result = await resources.finish(
        err(primary),
        () => {
          throw new Error("Failed work must not produce success Evidence");
        },
        "inspect_signal_decoders",
        caller.signal,
      );
      if (result.ok) throw new Error("Expected original physical failure");
      expect(failsClose ? result.error.cleanupPrimary : result.error).toBe(
        primary,
      );
      denied = false;
      await resources.close();
      expect(result.error.cleanupIncomplete).toBe(false);
      expect(failsClose ? result.error.cleanupPrimary : result.error).toBe(
        primary,
      );
    } finally {
      denied = false;
      await resources.close();
    }
  },
);
