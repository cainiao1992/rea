import { z } from "incur";

import { runProviderAnalysis } from "../application/DirectAnalysis.js";
import { createArtifactExtractionDestination } from "../application/ArtifactExtractionDestination.js";
import { logCliCommand } from "../cliLogging.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import type { Logger } from "../logger.js";
import type { CliInstance } from "./types.js";

export const registerArtifactCommands = (
  cli: CliInstance,
  logger: Logger,
): void => {
  registerInspectionCommand(cli, logger);
  registerExtractionCommand(cli, logger);
};

const registerExtractionCommand = (cli: CliInstance, logger: Logger): void => {
  cli.command(CLI_COMMANDS.extractArtifact, {
    description: "Extract explicitly selected artifact occurrences safely",
    args: z.object({
      path: z.string().describe("Application or package path"),
    }),
    options: z
      .object({
        paths: z
          .array(z.string().min(1))
          .min(1)
          .optional()
          .describe("Logical artifact paths selected for extraction"),
        occurrenceIds: z
          .array(z.string().regex(/^occ_[a-f0-9]{64}$/u))
          .min(1)
          .optional()
          .describe("Alternate exact occurrence IDs selected for extraction"),
      })
      .refine(
        ({ paths, occurrenceIds }) =>
          (paths === undefined) !== (occurrenceIds === undefined),
        "Provide paths or occurrence IDs",
      ),
    alias: { occurrenceIds: "occurrence-ids" },
    run: ({ args, options }) =>
      logCliCommand(logger, "extract-artifact", () =>
        runProviderAnalysis(
          args.path,
          "extract_artifact",
          {
            output_root: createArtifactExtractionDestination(),
            ...(options.paths !== undefined
              ? { paths: options.paths }
              : options.occurrenceIds !== undefined
                ? { occurrence_ids: options.occurrenceIds }
                : {}),
          },
          logger,
        ),
      ),
  });
};

const registerInspectionCommand = (cli: CliInstance, logger: Logger): void => {
  cli.command(CLI_COMMANDS.inspectArtifact, {
    description:
      "Inspect one artifact and return all available observations and next probes",
    args: z.object({
      path: z.string().describe("Application or package path"),
    }),
    options: z.object({
      integrityPolicy: z
        .enum(["fail", "record-and-continue"])
        .default("fail")
        .describe("Behavior when declared artifact integrity does not match"),
      integrityContinueApproved: z
        .boolean()
        .default(false)
        .describe("Approve continuing after recorded integrity mismatches"),
      nativeMountApproved: z
        .boolean()
        .default(false)
        .describe("Approve read-only native mounting when required"),
    }),
    alias: {
      integrityPolicy: "integrity-policy",
      integrityContinueApproved: "integrity-continue-approved",
      nativeMountApproved: "native-mount-approved",
    },
    run: ({ args, options }) =>
      logCliCommand(logger, "inspect-artifact", () =>
        runProviderAnalysis(
          args.path,
          "inspect_artifact",
          {
            integrity_policy: options.integrityPolicy,
            integrity_continue_approved: options.integrityContinueApproved,
            native_mount_approved: options.nativeMountApproved,
          },
          logger,
        ),
      ),
  });
};
