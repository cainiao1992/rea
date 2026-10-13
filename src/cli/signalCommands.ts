import { inspectSignalDecodersInputSchema } from "../domain/signals/signalDecoders.js";
import { z } from "incur";
import type { SignalRecordingService } from "../application/signals/SignalRecordingService.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { resolve } from "node:path";
import { createSignalRecordingService } from "../composition/signals.js";
import {
  signalRecordingOptionsSchema,
  signalRecordingSelectorBudgetIssue,
  withinSignalRecordingSelectorBudget,
} from "../domain/signals/signalRecording.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import type { Logger } from "pino";
import type { CliInstance } from "./types.js";
import { withCommandCancellation } from "./commandCancellation.js";
export const registerSignalCommands = (
  cli: CliInstance,
  logger: Logger,
  environment: Readonly<NodeJS.ProcessEnv>,
  service: Pick<
    SignalRecordingService,
    "decode" | "inspectDecoders" | "close"
  > = createSignalRecordingService(environment),
): void => {
  const finish = async (
    result: Awaited<ReturnType<SignalRecordingService["decode"]>>,
    operation: string,
  ) => {
    // A one-shot command must retry retained cleanup before discarding its owner.
    try {
      await service.close();
    } catch (cause) {
      const cleanup =
        cause instanceof AnalysisError
          ? cause
          : new ProviderCleanupError(
              "sigrok-recording",
              [],
              { reason: String(cause) },
              { cause, operation: operation },
            );
      if (result.ok) cleanup.retainPartialObservation(result.value);
      return projectAnalysisError(
        result.ok
          ? cleanup
          : analysisErrorWithCleanupFailure(result.error, cleanup, operation),
      );
    }
    return result.ok ? result.value : projectAnalysisError(result.error);
  };
  cli.command(CLI_COMMANDS.inspectSignalDecoders, {
    description: "Search installed sigrok decoders or selected decoder help",
    options: z
      .object({
        ...inspectSignalDecodersInputSchema.shape,
        limit: z
          .number()
          .int()
          .positive()
          .max(Number.MAX_SAFE_INTEGER)
          .optional()
          .describe(
            "Maximum matching decoders or help lines to return; defaults to 50",
          ),
        all: z
          .boolean()
          .default(false)
          .describe("Return all remaining matches"),
      })
      .superRefine((options, context) => {
        if (options.all && options.limit !== undefined)
          context.addIssue({
            code: "custom",
            path: ["all"],
            message: "all and limit are mutually exclusive",
          });
      }),
    run: ({ options: { all, ...options } }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.inspectSignalDecoders, async () =>
          finish(
            await service.inspectDecoders(
              { ...options, ...(all ? { limit: null } : {}) },
              { signal },
            ),
            "inspect_signal_decoders",
          ),
        ),
      ),
  });
  cli.command(CLI_COMMANDS.decodeSignalRecording, {
    description:
      "Decode an existing signal recording with caller-supplied sigrok",
    args: z.object({ path: z.string().describe("Local signal recording") }),
    options: z
      .object({
        ...signalRecordingOptionsSchema.shape,
        line_limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Returned output lines per page; default 50"),
        all_lines: z
          .boolean()
          .default(false)
          .describe(
            "Return all remaining output lines instead of a bounded page",
          ),
      })
      .superRefine((options, context) => {
        if (options.all_lines && options.line_limit !== undefined)
          context.addIssue({
            code: "custom",
            path: ["all_lines"],
            message: "all_lines and line_limit are mutually exclusive",
          });
      })
      .refine(
        withinSignalRecordingSelectorBudget,
        signalRecordingSelectorBudgetIssue,
      ),
    run: ({ args, options: { all_lines, ...options } }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.decodeSignalRecording, async () => {
          const result = await service.decode(
            {
              ...options,
              ...(all_lines ? { line_limit: null } : {}),
              path: resolve(args.path),
            },
            { signal },
          );
          return finish(result, "decode_signal_recording");
        }),
      ),
  });
};
