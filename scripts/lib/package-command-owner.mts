import { randomUUID } from "node:crypto";

import {
  ArtifactResourceScope,
  type ArtifactResourceOwner,
} from "../../src/artifacts/ArtifactResourceScope.js";
import { AnalysisCleanupLease } from "../../src/artifacts/AnalysisCleanupLease.js";
import type { RetainedResourceScope } from "../../src/application/AnalysisProvider.js";
import {
  prepareOwnedCommand,
  runOwnedCommand,
} from "../../src/process/OwnedCommand.js";
import {
  spawnOwnedProviderProcess,
  type OwnedProviderProcessSpawnOptions,
  type ProviderProcessSnapshot,
  type SpawnedOwnedProviderProcess,
} from "../../src/process/ProviderProcess.js";
import { retainOwnedCommandCleanup } from "../../src/providers/OwnedCommandCleanup.js";
import { WindowsOwnedProcess } from "../../src/windows/WindowsOwnedProcess.js";
import { npmInvocation } from "./npm-invocation.mjs";
import { createWindowsOwnedCommand } from "./windows-owned-command.mjs";

export interface PackageVerifierWorkspace {
  readonly path: string;
  close(): Promise<void>;
}

interface PackageCommandContext {
  readonly signal?: AbortSignal | undefined;
  readonly cwd?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly timeout?: number | undefined;
  readonly windowsHide?: boolean | undefined;
}

export type PackageCommandOptions = PackageCommandContext &
  (
    | {
        /** execFile-compatible capacity for each output stream. */
        readonly maxBuffer?: number | undefined;
        readonly diagnosticBytes?: never;
      }
    | {
        /** Canonical command capacity across both streams. */
        readonly diagnosticBytes: number;
        readonly maxBuffer?: never;
      }
  );

export interface PackageCommandOutput {
  readonly stdout: string;
  readonly stderr: string;
}

export interface PackageCleanupOwner {
  close(): Promise<void>;
  readonly cleanupResources?: readonly string[] | undefined;
}

export interface PackageVerifierCommands {
  exec(
    command: string,
    arguments_: readonly string[],
    options?: PackageCommandOptions,
  ): Promise<PackageCommandOutput>;
  execNpm(
    arguments_: readonly string[],
    options?: PackageCommandOptions,
  ): Promise<PackageCommandOutput>;
  run(
    command: string,
    arguments_: readonly string[],
    environment?: NodeJS.ProcessEnv,
  ): Promise<string>;
  runWithStatus(
    command: string,
    arguments_: readonly string[],
    environment?: NodeJS.ProcessEnv,
  ): Promise<{ readonly stdout: string; readonly status: number }>;
  adopt(owner: PackageCleanupOwner, resource?: string): void;
  close(): Promise<void>;
}

/** An ordinary nonzero exit whose process and output cleanup both completed. */
export class PackageCommandExitError extends Error {
  readonly stdout: string;
  readonly stderr: string;
  constructor(
    readonly command: string,
    readonly arguments_: readonly string[],
    readonly code: number,
    readonly snapshot: ProviderProcessSnapshot,
  ) {
    super(
      `Command failed: ${[command, ...arguments_].join(" ")}\n${snapshot.stderr.text}`,
    );
    this.name = "PackageCommandExitError";
    this.stdout = snapshot.stdout.text;
    this.stderr = snapshot.stderr.text;
  }
}

/** The same command/workspace capability remains available after failed close. */
export class PackageVerifierCleanupFailure extends Error {
  readonly path: string;
  constructor(
    cause: unknown,
    readonly cleanupOwner: PackageVerifierCommands,
    readonly workspace: PackageVerifierWorkspace,
  ) {
    super(
      `Package verification cleanup incomplete; retained ${workspace.path}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = "PackageVerifierCleanupFailure";
    this.path = workspace.path;
  }
}

const launchPackageCommand = async (
  input: OwnedProviderProcessSpawnOptions,
): Promise<SpawnedOwnedProviderProcess> => {
  if (process.platform !== "win32") return spawnOwnedProviderProcess(input);
  input.signal?.throwIfAborted();
  const child = createWindowsOwnedCommand({
    WindowsOwnedProcess,
    command: input.command,
    arguments: input.arguments,
    cwd: input.cwd,
    environment: {
      ...input.hostEnvironment,
      ...input.env,
      REA_PROCESS_RUN_ID: input.runId,
    },
  });
  // These labels describe the launch; cleanup authority is the exact native job.
  return {
    process: child,
    ownership: {
      runId: input.runId,
      leaderPid: child.pid,
      processGroupId: child.pid,
      expectedParentPid: process.pid,
    },
    cleanup: () => child.cleanup(),
  };
};

const commandLimits = (options: PackageCommandOptions) => {
  const timeout = options.timeout ?? 0;
  if (!Number.isSafeInteger(timeout) || timeout < 0)
    throw new RangeError(
      "Package command timeout must be a nonnegative integer",
    );
  if (options.maxBuffer !== undefined && options.diagnosticBytes !== undefined)
    throw new TypeError("Select a per-stream or aggregate command capacity");
  const capacity = options.diagnosticBytes ?? options.maxBuffer ?? 1024 * 1024;
  if (typeof capacity !== "number" || Number.isNaN(capacity) || capacity < 0)
    throw new RangeError("Package command output capacity must be nonnegative");
  if (process.platform === "win32" && options.windowsHide === false)
    throw new Error(
      "Owned package commands require hidden Windows process launch",
    );
  return {
    timeoutMs: timeout === 0 ? null : timeout,
    diagnosticBytes:
      options.diagnosticBytes === undefined
        ? { stdout: capacity, stderr: capacity }
        : capacity,
    acceptNonZeroExit: true,
  };
};

class PackageCommands implements PackageVerifierCommands {
  readonly #resources = new ArtifactResourceScope();
  readonly #controller = new AbortController();
  readonly #adopted = new WeakMap<PackageCleanupOwner, ArtifactResourceOwner>();
  readonly #resourceOwner: RetainedResourceScope;
  #closed = false;
  #workspaceReleaseStarted = false;
  #closing: Promise<void> | undefined;

  constructor(
    readonly workspace: PackageVerifierWorkspace,
    readonly launcher: (
      input: OwnedProviderProcessSpawnOptions,
    ) => Promise<SpawnedOwnedProviderProcess>,
  ) {
    this.#resourceOwner = {
      retain: (owner, resource) => this.adopt(owner, resource),
      run: (work) => this.#resources.run(work),
    };
  }

  exec(
    command: string,
    arguments_: readonly string[],
    options: PackageCommandOptions = {},
  ): Promise<PackageCommandOutput> {
    if (this.#closed)
      return Promise.reject(new Error("Package command owner is closed"));
    return this.#resources.run(async () => {
      try {
        const limits = commandLimits(options);
        const signal =
          options.signal === undefined
            ? this.#controller.signal
            : AbortSignal.any([this.#controller.signal, options.signal]);
        // Match execFile's command deadline while keeping native ownership
        // preparation independently bounded and inside this resource lifetime.
        await prepareOwnedCommand(signal);
        const snapshot = await runOwnedCommand(
          {
            command,
            arguments: arguments_,
            cwd: options.cwd ?? process.cwd(),
            hostEnvironment: options.env ?? process.env,
            expectedCommand: null,
            runId: `rea-package-command-${randomUUID()}`,
            sweepTokenOwnedProcesses: true,
          },
          limits,
          {
            signal,
            launcher: this.launcher,
          },
        );
        const output = {
          stdout: snapshot.stdout.text,
          stderr: snapshot.stderr.text,
        };
        if (typeof snapshot.exitCode === "number" && snapshot.exitCode !== 0)
          throw new PackageCommandExitError(
            command,
            arguments_,
            snapshot.exitCode,
            snapshot,
          );
        return output;
      } catch (cause: unknown) {
        retainOwnedCommandCleanup(
          cause,
          this.#resourceOwner,
          "package-verifier",
          command,
        );
        throw cause;
      }
    });
  }

  execNpm(
    arguments_: readonly string[],
    options: PackageCommandOptions = {},
  ): Promise<PackageCommandOutput> {
    const invocation = npmInvocation(arguments_, options.env ?? process.env);
    return this.exec(invocation.command, invocation.arguments, options);
  }

  async run(
    command: string,
    arguments_: readonly string[],
    environment?: NodeJS.ProcessEnv,
  ): Promise<string> {
    return (await this.exec(command, arguments_, { env: environment })).stdout;
  }

  async runWithStatus(
    command: string,
    arguments_: readonly string[],
    environment?: NodeJS.ProcessEnv,
  ): Promise<{ readonly stdout: string; readonly status: number }> {
    try {
      return {
        stdout: await this.run(command, arguments_, environment),
        status: 0,
      };
    } catch (cause: unknown) {
      if (cause instanceof PackageCommandExitError && cause.code === 1)
        return { stdout: cause.stdout, status: 1 };
      throw cause;
    }
  }

  adopt(owner: PackageCleanupOwner, resource = this.workspace.path): void {
    if (this.#workspaceReleaseStarted)
      throw new Error("Package workspace release has started");
    let retained = this.#adopted.get(owner);
    if (retained === undefined) {
      retained = {
        kind: "lease",
        resource,
        lease: AnalysisCleanupLease.forCloseOwner(owner, resource),
      };
      this.#adopted.set(owner, retained);
    }
    this.#resources.retain(retained);
  }

  close(): Promise<void> {
    this.#closed = true;
    this.#controller.abort(new Error("Package command owner closed"));
    if (this.#closing !== undefined) return this.#closing;
    let attempt: Promise<void>;
    attempt = this.#release().catch((cause: unknown) => {
      if (this.#closing === attempt) this.#closing = undefined;
      throw new PackageVerifierCleanupFailure(cause, this, this.workspace);
    });
    this.#closing = attempt;
    return attempt;
  }

  async #release(): Promise<void> {
    await this.#resources.close();
    this.#workspaceReleaseStarted = true;
    await this.workspace.close();
  }
}

/** Allocate one command lifetime whose workspace depends on completed cleanup. */
export async function createPackageVerifierCommands({
  workspace,
  launcher = launchPackageCommand,
}: {
  readonly workspace: PackageVerifierWorkspace;
  readonly launcher?: (
    input: OwnedProviderProcessSpawnOptions,
  ) => Promise<SpawnedOwnedProviderProcess>;
}): Promise<PackageVerifierCommands> {
  return new PackageCommands(workspace, launcher);
}
