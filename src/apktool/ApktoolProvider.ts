import { countDecodedFiles } from "./ApktoolDecodedInventory.js";
import { ApktoolWorkspace } from "./ApktoolWorkspace.js";
import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import {
  AnalysisCleanupLease,
  AnalysisCleanupLeaseGroup,
} from "../artifacts/AnalysisCleanupLease.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import {
  ArtifactFileCleanupFailure,
  artifactFilePrimaryFailure,
  artifactFileCancellationCause,
} from "../artifacts/ArtifactFileOperation.js";
import { PrivateRuntimeRoot } from "../process/PrivateRuntimeRoot.js";
import { capturedApktoolFailureOutput } from "./ApktoolCommandOutput.js";
import { ApktoolCommandCleanup } from "./ApktoolCommandCleanup.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import { analysisClientFailureForOperation } from "../providers/AnalysisClientFailure.js";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import type {
  ExecutionOptions,
  ProviderAvailability,
} from "../application/AnalysisProvider.js";
import { providerConfigurationRefusal } from "../domain/providerConfigurationRefusal.js";
import {
  createAnalysisExecution,
  createAnalysisExecutionEvidence,
  type AnalysisExecution,
} from "../application/AnalysisProvider.js";
import {
  androidLocaleDirectorySuffix,
  AGGREGATE_STRINGS_XML_MAX_BYTES,
  MAX_AGGREGATE_STRINGS,
  MAX_STRINGS,
  type ApktoolRequest,
  type StringTable,
} from "../domain/apktool/apktoolResourceAnalysis.js";
import {
  AnalysisCapabilityUnavailableError,
  AnalysisCancelledError,
  AnalysisProtocolError,
  AnalysisResourceConstraintError,
  AnalysisTimeoutError,
  AnalysisUnsupportedTargetError,
} from "../domain/analysisErrorCore.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import { err, ok, type Result } from "../domain/result.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import {
  OwnedCommandFailure,
  runOwnedCommand,
} from "../process/OwnedCommand.js";
import { snapshotEnvironment } from "../process/snapshotEnvironment.js";
import { WindowsBatchCommandError } from "../process/WindowsBatchCommand.js";
import {
  APKTOOL_COMMAND_ENV,
  ApktoolConfigurationFailure,
  apktoolConfigurationAvailability,
  apktoolInvocation,
  inspectApktoolClient,
  resolveApktoolCommand,
  type ApktoolCommandSelection,
  type ApktoolClientIdentity,
} from "./ApktoolConfiguration.js";
import {
  parseApktoolYml,
  parseDecodedStrings,
  parseManifestPackage,
  type ApktoolStringsDocumentError,
  type DecodedStringEntry,
} from "./ApktoolDecodeOutput.js";

/** Stable identity for the Apktool resource-decoding provider. */
export const APKTOOL_PROVIDER_IDENTITY = {
  id: "apktool",
  name: "Apktool",
  version: null,
} as const;

const DECODE_TIMEOUT_MS = 600_000;
const DECODE_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MANIFEST_MAX_BYTES = 512 * 1024;
const STRINGS_XML_MAX_BYTES = 8 * 1024 * 1024;
const MAX_DECODED_ENTRIES_VISITED = 100_000;
const STDERR_EXCERPT_BYTES = 512;

const throwIfCancelled = (
  operation: string,
  signal: AbortSignal | undefined,
): void => {
  if (signal?.aborted === true)
    throw new AnalysisCancelledError(operation, { cause: signal.reason });
};

interface DecodeLimits {
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

const runApktool = async (
  operation: string,
  targetPath: string,
  selection: ApktoolCommandSelection,
  arguments_: readonly string[],
  limits: DecodeLimits,
  signal: AbortSignal | undefined,
  environment: Readonly<Record<string, string | undefined>>,
  commands: ApktoolCommandCleanup,
  root: string,
): Promise<Result<{ stdout: string; stderr: string }, AnalysisError>> => {
  if (signal?.aborted === true)
    return err(
      new AnalysisCancelledError(operation, { cause: signal?.reason }),
    );
  let invocation: ReturnType<typeof apktoolInvocation>;
  try {
    invocation = apktoolInvocation(selection, arguments_, environment);
  } catch (cause) {
    if (!(cause instanceof WindowsBatchCommandError)) throw cause;
    const reason = `The apktool batch launcher cannot receive REA's decode paths through cmd.exe: ${cause.message}`;
    return err(
      new AnalysisCapabilityUnavailableError(
        APKTOOL_PROVIDER_IDENTITY.id,
        operation,
        reason,
        { cause, userMessage: reason },
      ),
    );
  }
  try {
    const output = await runOwnedCommand(
      {
        command: invocation.command,
        arguments: invocation.arguments,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
        // Apktool launchers are commonly interpreter scripts, so ownership is
        // proved by the run token rather than the launcher's argv prefix.
        expectedCommand: null,
        runId: randomUUID(),
        hostEnvironment: environment,
      },
      {
        timeoutMs: limits.timeoutMs,
        diagnosticBytes: limits.maxOutputBytes,
      },
      signal === undefined ? {} : { signal },
    );
    return ok({ stdout: output.stdout.text, stderr: output.stderr.text });
  } catch (cause) {
    return err(
      commands.retainFailure(
        cause,
        apktoolCommandFailure(cause, operation, targetPath, selection, limits),
        operation,
        root,
      ),
    );
  }
};

const apktoolCommandFailure = (
  cause: unknown,
  operation: string,
  targetPath: string,
  selection: ApktoolCommandSelection,
  limits: DecodeLimits,
): AnalysisError => {
  const capturedOutput = capturedApktoolFailureOutput(cause);
  if (!(cause instanceof OwnedCommandFailure))
    return new ProviderAdapterError("apktool", operation, {
      cause,
      diagnostics: {
        selected_command: selection.command,
        target_path: targetPath,
      },
      ...(capturedOutput === undefined ? {} : { capturedOutput }),
    });

  const output = cause.snapshot;
  if (cause.reason === "cancelled")
    return new AnalysisCancelledError(operation, {
      cause: cause.cancellation?.reason,
      ...(capturedOutput === undefined ? {} : { capturedOutput }),
    });
  if (cause.reason === "timeout")
    return new AnalysisTimeoutError(operation, limits.timeoutMs, {
      cause,
      ...(capturedOutput === undefined ? {} : { capturedOutput }),
    });
  if (cause.reason === "output-limit")
    return new AnalysisResourceConstraintError(
      operation,
      "memory",
      `apktool output exceeded the ${String(limits.maxOutputBytes)}-byte capture budget`,
      { max_output_bytes: limits.maxOutputBytes },
      {
        cause,
        ...(capturedOutput === undefined ? {} : { capturedOutput }),
      },
    );
  // A physical launcher/capture failure does not establish target refusal.
  // Only a fully collected ordinary nonzero decode exit carries that meaning.
  if (
    cause.processError !== undefined ||
    cause.collectionFailure ||
    cause.preparationFailure !== undefined ||
    output === null ||
    output.exitCode === null ||
    output.exitCode === undefined ||
    output.exitCode === 0 ||
    output.signal !== null ||
    output.outputIncomplete === true ||
    output.diagnosticTruncated === true
  )
    return new ProviderAdapterError("apktool", operation, {
      cause,
      userMessage: `The selected Apktool command failed while decoding ${targetPath}`,
      diagnostics: {
        selected_command: selection.command,
        target_path: targetPath,
      },
      ...(capturedOutput === undefined ? {} : { capturedOutput }),
    });
  return new AnalysisUnsupportedTargetError(
    operation,
    targetPath,
    output?.stderr.text.trim().slice(0, STDERR_EXCERPT_BYTES) ||
      `apktool exited with code ${String(output?.exitCode ?? "unknown")} for ${operation}`,
    {
      cause,
      ...(capturedOutput === undefined ? {} : { capturedOutput }),
    },
  );
};

export interface ApktoolProviderOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly removeWorkspace?: (path: string) => Promise<void>;
}

/**
 * Apktool resource decoding over a caller-selected launcher.
 *
 * Decoding happens in a provider-owned temporary workspace that is removed
 * once the requested facts are projected; smali production is skipped
 * (`--no-src`) because Java-source recovery belongs to the JADX family.
 */
export class ApktoolProvider {
  private readonly selectedEnvironment:
    | Readonly<Record<string, string | undefined>>
    | undefined;

  readonly #artifacts = new ArtifactResourceScope();
  private readonly removeWorkspace:
    | ((path: string) => Promise<void>)
    | undefined;
  readonly #commands = new ApktoolCommandCleanup();
  readonly #shutdown = new AbortController();
  readonly #active = new Set<Promise<void>>();
  #closing = false;
  #closePromise: Promise<void> | undefined;

  constructor(options: ApktoolProviderOptions = {}) {
    this.selectedEnvironment =
      options.environment === undefined
        ? undefined
        : snapshotEnvironment(options.environment);
    this.removeWorkspace = options.removeWorkspace;
  }

  private operationEnvironment(): Readonly<NodeJS.ProcessEnv> {
    const ambient = snapshotEnvironment(process.env);
    if (this.selectedEnvironment === undefined) return ambient;
    // Child inheritance is sampled per operation. An explicit map keeps its
    // launcher choice authoritative, including an omitted command selecting PATH.
    return snapshotEnvironment({
      ...ambient,
      ...this.selectedEnvironment,
      [APKTOOL_COMMAND_ENV]: this.selectedEnvironment[APKTOOL_COMMAND_ENV],
    });
  }

  /** Probe the selected apktool launcher; decodes nothing. */
  inspectAvailability(signal?: AbortSignal): Promise<ProviderAvailability> {
    if (this.#closing)
      return Promise.reject(
        new AnalysisCancelledError("inspect_apktool_client"),
      );
    const operationSignal =
      signal === undefined
        ? this.#shutdown.signal
        : AbortSignal.any([signal, this.#shutdown.signal]);
    return this.#track(
      this.#commands
        .run(
          () =>
            this.#artifacts.run(() =>
              this.#inspectAvailability(operationSignal),
            ),
          "inspect_apktool_client",
        )
        .catch((cause: unknown) => {
          throw analysisClientFailureForOperation(
            cause,
            "apktool",
            "inspect_apktool_client",
          );
        }),
    );
  }

  async #inspectAvailability(
    signal: AbortSignal,
  ): Promise<ProviderAvailability> {
    const environment = this.operationEnvironment();
    try {
      const selection = await resolveApktoolCommand(
        environment,
        process.platform,
        signal,
      );
      await inspectApktoolClient(selection, this.#commands, {
        signal,
        environment,
      });
      throwIfCancelled("inspect_apktool_client", signal);
      return {
        status: "available",
        code: null,
        reason: null,
        diagnostics: {
          selected_command: selection.command,
          command_source: selection.commandSource,
        },
      };
    } catch (cause) {
      if (cause instanceof ApktoolConfigurationFailure) {
        return apktoolConfigurationAvailability(cause);
      }
      throw cause;
    }
  }

  /** Retain failed cleanup ownership and retry it on close. */
  async close(): Promise<void> {
    this.#closing = true;
    this.#shutdown.abort();
    this.#closePromise ??= this.#drainAndClean().catch((cause: unknown) => {
      this.#closePromise = undefined;
      throw cause;
    });
    return this.#closePromise;
  }

  execute(
    request: ApktoolRequest,
    options?: ExecutionOptions,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    if (this.#closing)
      return Promise.resolve(
        err(new AnalysisCancelledError(request.operation)),
      );
    const signal =
      options?.signal === undefined
        ? this.#shutdown.signal
        : AbortSignal.any([options.signal, this.#shutdown.signal]);
    return this.#track(
      this.#commands
        .run(
          () => this.#artifacts.run(() => this.#execute(request, signal)),
          request.operation,
        )
        .catch((cause: unknown) =>
          err(
            analysisClientFailureForOperation(
              cause,
              "apktool",
              request.operation,
            ),
          ),
        ),
    );
  }

  async #execute(
    request: ApktoolRequest,
    signal: AbortSignal,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    if (signal?.aborted === true)
      return err(
        new AnalysisCancelledError(request.operation, { cause: signal.reason }),
      );
    const environment = this.operationEnvironment();
    let selection: ApktoolCommandSelection;
    let identity: ApktoolClientIdentity;
    try {
      selection = await resolveApktoolCommand(
        environment,
        process.platform,
        signal,
      );
      identity = await inspectApktoolClient(selection, this.#commands, {
        signal,
        environment,
      });
    } catch (cause) {
      if (cause instanceof AnalysisError)
        return err(
          analysisClientFailureForOperation(
            cause,
            "apktool",
            request.operation,
          ),
        );
      if (cause instanceof ApktoolConfigurationFailure) {
        return err(
          providerConfigurationRefusal(
            APKTOOL_PROVIDER_IDENTITY.id,
            request.operation,
            cause,
          ),
        );
      }
      return err(
        new AnalysisProtocolError(
          `apktool version probe failed for ${request.operation}`,
          { cause },
        ),
      );
    }
    if (signal.aborted)
      return err(
        new AnalysisCancelledError(request.operation, { cause: signal.reason }),
      );
    const client = {
      command: selection.command,
      command_source: selection.commandSource,
      apktool_version: identity.version,
    };
    const provider = {
      ...APKTOOL_PROVIDER_IDENTITY,
      version: identity.version,
    };
    if (request.operation === "inspect_apktool_client")
      return ok(
        createAnalysisExecution({ client }, provider, {
          limitations: identity.limitations,
        }),
      );
    return this.decodeResources(
      request.operation,
      selection,
      environment,
      client,
      provider,
      request.input,
      identity.limitations,
      signal,
    );
  }

  #track<T>(operation: Promise<T>): Promise<T> {
    const settled = operation.then(
      () => undefined,
      () => undefined,
    );
    this.#active.add(settled);
    void settled.then(() => this.#active.delete(settled));
    return operation;
  }

  async #drainAndClean(): Promise<void> {
    await Promise.all(this.#active);
    const failures: AnalysisError[] = [];
    for (const close of [
      () => this.#commands.close(),
      () => this.#artifacts.close(),
    ]) {
      try {
        await close();
      } catch (cause) {
        failures.push(
          analysisClientFailureForOperation(cause, "apktool", "close"),
        );
      }
    }
    const first = failures.shift();
    if (first === undefined) return;
    throw failures.reduce(
      (primary, cleanup) =>
        analysisErrorWithCleanupFailure(
          primary,
          cleanup,
          "close",
        ).bindCleanupDependencies([primary, cleanup]),
      first,
    );
  }

  private async decodeResources(
    operation: "decode_android_resources",
    selection: ApktoolCommandSelection,
    environment: Readonly<NodeJS.ProcessEnv>,
    client: {
      command: string;
      command_source: string;
      apktool_version: string | null;
    },
    provider: { id: string; name: string; version: string | null },
    input: {
      readonly path: string;
      readonly include_strings: boolean;
      readonly locale?: string | undefined;
      readonly locales?: readonly string[] | undefined;
    },
    clientLimitations: readonly string[],
    signal: AbortSignal | undefined,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    const runtime = await PrivateRuntimeRoot.create({ prefix: "rea-apktool-" });
    const resources = new ApktoolWorkspace(
      runtime,
      this.#commands,
      this.removeWorkspace,
    );
    const root = resources.path;
    const workspace = join(root, "decoded");
    const snapshot = join(root, "input.apk");
    const framework = join(root, "framework");
    const lease = new AnalysisCleanupLease(() => resources.close(), [root]);
    const owner = { kind: "lease" as const, resource: root, lease };
    this.#artifacts.retain(owner);
    let result: Result<AnalysisExecution, AnalysisError>;
    try {
      const identity = await resources.snapshotInput(
        input.path,
        operation,
        signal,
      );
      const sha256 = identity.sha256;
      await mkdir(workspace);
      await mkdir(framework);
      const decoded = await runApktool(
        operation,
        input.path,
        selection,
        [
          "d",
          "--no-src",
          "-f",
          "-o",
          workspace,
          "--frame-path",
          framework,
          snapshot,
        ],
        {
          timeoutMs: DECODE_TIMEOUT_MS,
          maxOutputBytes: DECODE_MAX_OUTPUT_BYTES,
        },
        signal,
        environment,
        this.#commands,
        root,
      );
      if (!decoded.ok) {
        throw decoded.error;
      }
      throwIfCancelled(operation, signal);
      const yml = await resources.readText(
        join(workspace, "apktool.yml"),
        MANIFEST_MAX_BYTES,
        signal,
      );
      if (yml.text === null || yml.truncated) {
        throw new AnalysisProtocolError(
          `apktool produced missing or oversized apktool.yml: ${input.path}`,
        );
      }
      const metadata = parseApktoolYml(yml.text);
      const manifestRead = await resources.readText(
        join(workspace, "AndroidManifest.xml"),
        MANIFEST_MAX_BYTES,
        signal,
      );
      const manifest = manifestRead.text;
      const packageName =
        manifest === null || manifestRead.truncated
          ? null
          : parseManifestPackage(manifest);
      let strings: Array<{ name: string; value: string }>;
      let locale: string | null;
      let stringTables: StringTable[] | undefined;
      const limitations: string[] = [
        ...clientLimitations,
        "Decoding skips smali (--no-src); Java-source recovery belongs to the JADX family",
      ];
      let stringsTruncated = false;
      let stringsUnparsedCount = 0;
      let stringsTotalCount: number | null = null;
      let stringsDocumentFailure: ApktoolStringsDocumentError | undefined;
      let stringsMissingLimitation: string | undefined;

      const files = await countDecodedFiles(
        resources,
        workspace,
        signal,
        MAX_DECODED_ENTRIES_VISITED,
      );
      throwIfCancelled(operation, signal);

      let aggregateCapped = false;
      let anyTablePartial = false;

      if (input.locales === undefined) {
        locale = input.locale ?? null;
        const stringsDirectory =
          input.locale === undefined
            ? "values"
            : `values-${androidLocaleDirectorySuffix(input.locale)}`;
        const stringsRead = input.include_strings
          ? await resources.readText(
              join(workspace, "res", stringsDirectory, "strings.xml"),
              STRINGS_XML_MAX_BYTES,
              signal,
            )
          : { text: null, truncated: false };
        stringsTruncated = stringsRead.truncated;
        const stringsXml = stringsRead.truncated ? null : stringsRead.text;
        const stringsProjection =
          stringsXml === null ? undefined : parseDecodedStrings(stringsXml);
        const parsedStrings =
          stringsProjection?.ok === true ? stringsProjection.value : undefined;
        stringsDocumentFailure =
          stringsProjection?.ok === false ? stringsProjection.error : undefined;
        strings = parsedStrings?.entries.slice(0, MAX_STRINGS) ?? [];
        stringsTotalCount = parsedStrings?.entries.length ?? null;
        stringsUnparsedCount = parsedStrings?.unparsedCount ?? 0;

        if (input.include_strings && stringsRead.text === null) {
          stringsMissingLimitation =
            input.locale !== undefined
              ? `No strings.xml was found for locale ${input.locale}`
              : "No default res/values/strings.xml was found in the decoded workspace";
        }
        if (stringsMissingLimitation !== undefined) {
          limitations.push(stringsMissingLimitation);
        }
        if (stringsDocumentFailure !== undefined) {
          limitations.push(
            `String table ${JSON.stringify(`res/${stringsDirectory}/strings.xml`)} could not be projected: ${stringsDocumentFailure.message}; entry counts are unknown`,
          );
        }
        if (stringsUnparsedCount > 0) {
          limitations.push(
            `String entries omitted due to unsupported markup or missing names: ${String(stringsUnparsedCount)}`,
          );
        }
        if (stringsTotalCount !== null && stringsTotalCount > MAX_STRINGS) {
          limitations.push(
            `strings reports the first ${String(MAX_STRINGS)} of ${String(stringsTotalCount)} entries`,
          );
        }
        if (stringsTruncated) {
          limitations.push(
            `strings.xml exceeds the ${String(STRINGS_XML_MAX_BYTES)}-byte projection budget`,
          );
        }
      } else {
        locale = input.locale ?? null;
        stringTables = [];

        const requestedLocales: Array<{
          readonly locale: string | null;
          readonly isPrimary: boolean;
        }> = [];

        requestedLocales.push({
          locale,
          isPrimary: true,
        });

        for (const loc of input.locales) {
          if (!requestedLocales.some((r) => r.locale === loc)) {
            requestedLocales.push({ locale: loc, isPrimary: false });
          }
        }

        if (!input.include_strings) {
          strings = [];
          stringTables = [];
        } else {
          let aggregateXmlBytes = 0;
          let aggregateStringsCount = 0;
          const tableLimitations: string[] = [];

          type PhysicalCached =
            | {
                readonly status: "missing" | "oversized" | "malformed";
                readonly total_count: number | null;
                readonly unparsed_count: number | null;
                readonly coverage: "complete" | "partial";
                readonly limitation: string;
              }
            | {
                readonly status: "present";
                readonly entries: readonly DecodedStringEntry[];
                readonly unparsed_count: number;
              };

          const physicalCache = new Map<string, PhysicalCached>();

          for (const item of requestedLocales) {
            throwIfCancelled(operation, signal);
            const loc = item.locale;
            const dirName =
              loc === null
                ? "values"
                : `values-${androidLocaleDirectorySuffix(loc)}`;
            const filePath = join(workspace, "res", dirName, "strings.xml");
            const tableLabel =
              loc === null
                ? "default res/values/strings.xml"
                : `res/${dirName}/strings.xml`;

            let cached = physicalCache.get(dirName);
            if (cached === undefined) {
              const remainingXmlBudget = Math.max(
                0,
                AGGREGATE_STRINGS_XML_MAX_BYTES - aggregateXmlBytes,
              );
              const remainingStringsBudget = Math.max(
                0,
                MAX_AGGREGATE_STRINGS - aggregateStringsCount,
              );
              if (remainingXmlBudget <= 0 || remainingStringsBudget <= 0) {
                aggregateCapped = true;
                stringTables.push({
                  locale: loc,
                  status: "skipped",
                  strings: [],
                  total_count: null,
                  unparsed_count: null,
                  coverage: "partial",
                });
                tableLimitations.push(
                  `Projection for ${tableLabel} skipped: aggregate resource limit reached`,
                );
                continue;
              }

              const tableBudget = Math.min(
                STRINGS_XML_MAX_BYTES,
                remainingXmlBudget,
              );
              const stringsRead = await resources.readText(
                filePath,
                tableBudget,
                signal,
              );

              if (stringsRead.text !== null) {
                if (stringsRead.truncated) {
                  aggregateXmlBytes += tableBudget;
                } else {
                  aggregateXmlBytes += Buffer.byteLength(
                    stringsRead.text,
                    "utf-8",
                  );
                }
              }

              if (stringsRead.text === null) {
                cached = {
                  status: "missing",
                  total_count: 0,
                  unparsed_count: 0,
                  coverage: "complete",
                  limitation:
                    loc !== null
                      ? `No strings.xml was found for locale ${loc}`
                      : "No default res/values/strings.xml was found in the decoded workspace",
                };
                physicalCache.set(dirName, cached);
              } else if (stringsRead.truncated) {
                if (tableBudget < STRINGS_XML_MAX_BYTES) {
                  aggregateCapped = true;
                }
                cached = {
                  status: "oversized",
                  total_count: null,
                  unparsed_count: null,
                  coverage: "partial",
                  limitation:
                    loc === null
                      ? `strings.xml exceeds the ${String(tableBudget)}-byte projection budget`
                      : `strings.xml for locale ${loc} exceeds the ${String(tableBudget)}-byte projection budget`,
                };
                physicalCache.set(dirName, cached);
              } else {
                const parsed = parseDecodedStrings(stringsRead.text);
                if (!parsed.ok) {
                  cached = {
                    status: "malformed",
                    total_count: null,
                    unparsed_count: null,
                    coverage: "partial",
                    limitation: `String table ${JSON.stringify(`res/${dirName}/strings.xml`)} could not be projected: ${parsed.error.message}; entry counts are unknown`,
                  };
                  physicalCache.set(dirName, cached);
                } else {
                  cached = {
                    status: "present",
                    entries: parsed.value.entries,
                    unparsed_count: parsed.value.unparsedCount,
                  };
                  physicalCache.set(dirName, cached);
                }
              }
            }

            if (cached.status !== "present") {
              stringTables.push({
                locale: loc,
                status: cached.status,
                strings: [],
                total_count: cached.total_count,
                unparsed_count: cached.unparsed_count,
                coverage: cached.coverage,
              });
              if (!tableLimitations.includes(cached.limitation)) {
                tableLimitations.push(cached.limitation);
              }
              continue;
            }

            const totalCount = cached.entries.length;
            const remainingStringsBudget = Math.max(
              0,
              MAX_AGGREGATE_STRINGS - aggregateStringsCount,
            );
            const tableLimit = Math.min(MAX_STRINGS, remainingStringsBudget);

            if (remainingStringsBudget <= 0) {
              aggregateCapped = true;
              stringTables.push({
                locale: loc,
                status: "skipped",
                strings: [],
                total_count: null,
                unparsed_count: null,
                coverage: "partial",
              });
              tableLimitations.push(
                `Projection for ${tableLabel} skipped: aggregate resource limit reached`,
              );
              continue;
            }

            const bounded = cached.entries.slice(0, tableLimit);
            aggregateStringsCount += bounded.length;

            if (item.isPrimary) {
              // Primary table copy in top-level strings also consumes output entry budget
              aggregateStringsCount += bounded.length;
            }

            if (bounded.length < Math.min(totalCount, MAX_STRINGS)) {
              aggregateCapped = true;
            }

            const tableCoverage =
              totalCount > MAX_STRINGS ||
              bounded.length < totalCount ||
              cached.unparsed_count > 0
                ? "partial"
                : "complete";

            stringTables.push({
              locale: loc,
              status: "present",
              strings: bounded,
              total_count: totalCount,
              unparsed_count: cached.unparsed_count,
              coverage: tableCoverage,
            });

            if (cached.unparsed_count > 0) {
              tableLimitations.push(
                loc === null
                  ? `String entries omitted due to unsupported markup or missing names: ${String(cached.unparsed_count)}`
                  : `String entries omitted in locale ${loc} due to unsupported markup or missing names: ${String(cached.unparsed_count)}`,
              );
            }
            if (totalCount > MAX_STRINGS) {
              tableLimitations.push(
                loc === null
                  ? `strings reports the first ${String(MAX_STRINGS)} of ${String(totalCount)} entries`
                  : `Locale ${loc} strings reports the first ${String(MAX_STRINGS)} of ${String(totalCount)} entries`,
              );
            } else if (bounded.length < totalCount) {
              tableLimitations.push(
                `Locale ${loc ?? "default"} strings reports ${String(bounded.length)} entries due to aggregate strings limit`,
              );
            }
          }

          limitations.push(...tableLimitations);

          const primaryTable = stringTables.find((t) => t.locale === locale);
          strings = primaryTable?.strings ?? [];
        }

        anyTablePartial = stringTables.some(
          (t) =>
            t.coverage === "partial" ||
            t.status === "oversized" ||
            t.status === "malformed" ||
            t.status === "skipped",
        );
      }

      const coverage =
        (input.locales === undefined
          ? (stringsTotalCount !== null && stringsTotalCount > MAX_STRINGS) ||
            stringsTruncated ||
            stringsUnparsedCount > 0 ||
            stringsDocumentFailure !== undefined
          : anyTablePartial || aggregateCapped) ||
        manifestRead.truncated ||
        files.capped ||
        files.unreadableStringsTables.length > 0
          ? "partial"
          : "complete";

      if (manifestRead.truncated) {
        limitations.push(
          `manifest is truncated at ${String(MANIFEST_MAX_BYTES)} bytes`,
        );
      }
      if (files.unreadableStringsTables.length > 0) {
        limitations.push(
          `String tables omitted because they are not regular files: ${files.unreadableStringsTables.map((table) => `${JSON.stringify(table.path)} (${table.kind})`).join(", ")}`,
        );
      }
      if (files.otherStringsTables.length > 0) {
        limitations.push(
          `Other strings tables are not selected by locale; their resource configuration suffixes are preserved without inferring Android runtime matching: ${files.otherStringsTables.map((table) => JSON.stringify(table)).join(", ")}`,
        );
      }
      if (files.capped) {
        limitations.push(
          `Decoded workspace enumeration stopped after ${String(MAX_DECODED_ENTRIES_VISITED)} entries; decoded_file_count and locales may be partial`,
        );
      }
      if (aggregateCapped) {
        limitations.push(
          "Aggregate string table projection stopped due to resource limits",
        );
      }

      result = ok(
        createAnalysisExecution(
          {
            client,
            target: { path: input.path, bytes: identity.bytes, sha256 },
            metadata: {
              version_name: metadata.versionName,
              version_code: metadata.versionCode,
              min_sdk_version: metadata.minSdkVersion,
              target_sdk_version: metadata.targetSdkVersion,
              package_name: packageName,
            },
            manifest,
            strings,
            locale,
            locales: files.locales,
            ...(stringTables !== undefined
              ? { string_tables: stringTables }
              : {}),
            decoded_file_count: files.count,
            coverage,
          },
          provider,
          {
            subject: { path: input.path, sha256, format: "apk" },
            limitations,
          },
        ),
      );
    } catch (cause) {
      const physical = artifactFilePrimaryFailure(cause);
      const primary =
        physical instanceof AnalysisError
          ? physical
          : physical instanceof ArtifactReaderFailure &&
              physical.reason === "cancelled"
            ? new AnalysisCancelledError(operation, {
                cause: artifactFileCancellationCause(physical),
              })
            : new AnalysisProtocolError("Apktool resource projection failed", {
                cause: physical,
              });
      const failure = analysisClientFailureForOperation(
        cause,
        "apktool",
        operation,
      );
      if (
        cause instanceof ArtifactReaderFailure &&
        cause.cleanup !== undefined &&
        !(cause instanceof ArtifactFileCleanupFailure)
      )
        new AnalysisCleanupLeaseGroup(failure, [lease]);
      const retained =
        physical === cause && cause instanceof AnalysisError
          ? cause
          : failure.cleanupIncomplete
            ? analysisErrorWithCleanupFailure(
                primary,
                failure,
                operation,
              ).bindCleanupDependencies([primary, failure])
            : primary;
      if (
        resources.snapshot !== undefined &&
        retained.partialObservation === undefined
      )
        retained.retainPartialObservation({
          kind: "file-snapshot-hash",
          ...resources.snapshot,
        });
      result = err(retained);
    }
    const released = await this.#artifacts.release(owner);
    const observation =
      result.ok && (released.kind === "failed" || signal?.aborted === true)
        ? createAnalysisExecutionEvidence(
            operation,
            input,
            result.value,
            "observed",
          )
        : undefined;
    if (result.ok && signal?.aborted)
      result = err(
        new AnalysisCancelledError(operation, {
          cause: signal.reason,
          partialObservation: observation,
        }),
      );
    if (released.kind === "failed") {
      const cleanup = new ProviderCleanupError(
        "apktool",
        [root],
        {},
        {
          operation,
          cause: released.cause,
          ...(observation === undefined
            ? {}
            : { partialObservation: observation }),
        },
      );
      new AnalysisCleanupLeaseGroup(cleanup, [lease]);
      return err(
        result.ok
          ? cleanup
          : analysisErrorWithCleanupFailure(
              result.error,
              cleanup,
              operation,
            ).bindCleanupDependencies([result.error, cleanup]),
      );
    }
    return result;
  }
}
