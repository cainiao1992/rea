import { projectCliAnalysisResult } from "./projectCliAnalysisResult.js";
import { z } from "incur";
import { AndroidAnalysisService } from "../application/android/AndroidAnalysisService.js";
import { createAndroidAnalysisProvider } from "../composition/android.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import type { AndroidOperation } from "../domain/android/androidAnalysis.js";
import type { Logger } from "pino";
import type { CliInstance } from "./types.js";
import { withCommandCancellation } from "./commandCancellation.js";
import { finishAnalysisCommand } from "./finishAnalysisCommand.js";
import {
  analysisEvidenceDeliveryOptions,
  deliverCliAnalysisEvidence,
  parseCliAnalysisEvidenceDelivery,
} from "./analysisEvidenceDelivery.js";
import { androidPackageDeliverySchema } from "../domain/android/androidPackageQuery.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";

/** Expose the same explicit APK requests through one-shot CLI commands. */
export const registerAndroidCommands = (
  cli: CliInstance,
  logger: Logger,
  environment: Readonly<Record<string, string | undefined>>,
): void => {
  const provider = createAndroidAnalysisProvider(environment);
  const service = new AndroidAnalysisService(provider);
  const execute = (name: string, operation: AndroidOperation, input: unknown) =>
    withCommandCancellation((signal) =>
      logCliCommand(logger, name, () =>
        finishAnalysisCommand(
          () => service.execute(operation, input, { signal }),
          { close: () => provider.close() },
          "jadx",
          operation,
          signal,
        ).then(projectCliAnalysisResult),
      ),
    );
  const path = z.string().describe("Local standalone APK path");
  const className = z.string().describe("Exact fully qualified class name");
  cli.command(CLI_COMMANDS.inspectAndroidPackage, {
    description:
      "Inspect APK declarations and decoded manifest without executing it",
    args: z.object({ path }),
    options: z.object({
      ...analysisEvidenceDeliveryOptions,
      view: z
        .string()
        .optional()
        .describe(
          "JSON android manifest/components/component-summary view; requires --detail summary and --evidence_output",
        ),
    }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.inspectAndroidPackage, async () => {
          const delivery = parseCliAnalysisEvidenceDelivery(
            "inspect_android_package",
            options,
            androidPackageDeliverySchema,
          );
          if (!delivery.ok) return projectAnalysisError(delivery.error);
          return deliverCliAnalysisEvidence({
            run: () =>
              service.execute("inspect_android_package", args, { signal }),
            service: { close: () => provider.close() },
            providerId: "jadx",
            operation: "inspect_android_package",
            signal,
            detail: delivery.value.detail,
            evidenceOutput: delivery.value.evidenceOutput,
            ...(delivery.value.view === undefined
              ? {}
              : { view: delivery.value.view }),
          });
        }),
      ),
  });
  cli.command(CLI_COMMANDS.searchAndroidClasses, {
    description: "Search APK class names; empty query inventories all classes",
    args: z.object({
      path,
      query: z
        .string()
        .describe(
          "Case-sensitive class-name substring; empty lists all classes",
        ),
    }),
    run: ({ args }) =>
      execute(
        CLI_COMMANDS.searchAndroidClasses,
        "search_android_classes",
        args,
      ),
  });
  cli.command(CLI_COMMANDS.inspectAndroidClass, {
    description: "Inspect one exact APK class's member inventory",
    args: z.object({ path, className }),
    run: ({ args }) =>
      execute(CLI_COMMANDS.inspectAndroidClass, "inspect_android_class", {
        path: args.path,
        class_name: args.className,
      }),
  });
  cli.command(CLI_COMMANDS.inspectAndroidMethod, {
    description: "Decompile one APK method with explicit overload selection",
    args: z.object({
      path,
      className,
      methodName: z.string().describe("Exact declared method name"),
    }),
    options: z.object({
      overloadIndex: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe(
          "Explicit zero-based index among same-name methods; required when ambiguous",
        ),
    }),
    run: ({ args, options }) =>
      execute(CLI_COMMANDS.inspectAndroidMethod, "inspect_android_method", {
        path: args.path,
        class_name: args.className,
        method_name: args.methodName,
        ...(options.overloadIndex === undefined
          ? {}
          : { overload_index: options.overloadIndex }),
      }),
  });
  cli.command(CLI_COMMANDS.traceAndroidReferences, {
    description:
      "Trace incoming APK using nodes for a class or selected method",
    args: z.object({ path, className }),
    options: z.object({
      methodName: z
        .string()
        .optional()
        .describe("Declared method name; omit for class references"),
      overloadIndex: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe("Index among same-name methods from inspect-android-class"),
    }),
    run: ({ args, options }) =>
      execute(CLI_COMMANDS.traceAndroidReferences, "trace_android_references", {
        path: args.path,
        class_name: args.className,
        ...(options.methodName === undefined
          ? {}
          : { method_name: options.methodName }),
        ...(options.overloadIndex === undefined
          ? {}
          : { overload_index: options.overloadIndex }),
      }),
  });
};
