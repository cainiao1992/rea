import { formatCliOutput } from "./cli/cliOutputFormatter.js";

import { jsonOutputParts } from "./cli/jsonOutput.js";
import { jsonLinesErrorRecord } from "./cli/jsonLines.js";
import {
  versionReport,
  type VersionReportHost,
} from "./domain/versionReport.js";

// The launcher and compiled CLI drivers share this lightweight entrypoint.
export { cliConfigurationError } from "./cliConfiguration.js";

const UNSUPPORTED_OUTPUT_COMBINATION_MESSAGE =
  "Token windows cannot preserve structured output. Remove --token-limit/--token-offset and use --filter-output or command pagination.";

type StructuredOutputFormat = "json" | "jsonl" | "yaml";
/** Output formats Incur renders, in its documented order. */
export const CLI_OUTPUT_FORMATS = [
  "toon",
  "json",
  "yaml",
  "md",
  "jsonl",
] as const;
export type CliOutputFormat = (typeof CLI_OUTPUT_FORMATS)[number];
const INCUR_OUTPUT_FORMATS: ReadonlySet<string> = new Set(CLI_OUTPUT_FORMATS);

const isCliOutputFormat = (value: string): value is CliOutputFormat =>
  INCUR_OUTPUT_FORMATS.has(value);

/**
 * Render a document REA writes outside Incur's command pipeline. JSON follows
 * the CLI contract: indented for a terminal, compact when piped or redirected.
 */
export const renderCliDocument = (
  value: unknown,
  format: CliOutputFormat,
  stdoutIsTerminal: boolean,
): string =>
  format === "json" || format === "jsonl"
    ? [...jsonOutputParts(value, format, stdoutIsTerminal)].join("")
    : `${formatCliOutput(value, format)}\n`;
/** Global output flags that take a value. */
const VALUED_OUTPUT_FLAGS = new Set([
  "--format",
  "--filter-output",
  "--token-limit",
  "--token-offset",
]);

const ROOT_UPDATE_OUTPUT_FLAGS = new Set([
  "--json",
  "--full-output",
  "--token-count",
]);

/** Valueless flags Incur removes from every position before command parsing. */
const INCUR_BUILTIN_FLAGS = new Set([
  "--full-output",
  "--llms",
  "--llms-full",
  "--mcp",
  "--help",
  "-h",
  "--update",
  // Incur's internal update-check flag.
  "--incur-update-check",
  "--schema",
  "--json",
  "--token-count",
]);

/**
 * Incur's message when its builtin pass rejects this spaced value of a valued
 * output flag, or undefined when Incur accepts it.
 */
export const cliOutputValueRejection = (
  flag: string,
  value: string,
): string | undefined => {
  if (flag === "--format")
    return INCUR_OUTPUT_FORMATS.has(value)
      ? undefined
      : `Invalid format: "${value}". Expected one of: ${[...INCUR_OUTPUT_FORMATS].join(", ")}`;
  if (
    (flag === "--token-limit" || flag === "--token-offset") &&
    (!Number.isFinite(Number(value)) || value.trim() === "")
  )
    return `Invalid value for ${flag}: "${value}"`;
  return undefined;
};

/** Command tokens and output-flag values as Incur's builtin pass assigns them. */
export interface IncurBuiltinArgumentSplit {
  /** Tokens left for command resolution and command option parsing. */
  readonly command: readonly string[];
  /** Positions of nonempty values consumed by valued output flags. */
  readonly outputValues: readonly {
    readonly flag: string;
    readonly index: number;
  }[];
}

/**
 * Mirror Incur's builtin pass over normalized arguments without stopping at a
 * rejected value, so callers can still see every later token. REA configures
 * neither a config flag nor global options, which Incur would also remove.
 */
export const splitIncurBuiltinArguments = (
  arguments_: readonly string[],
): IncurBuiltinArgumentSplit => {
  const command: string[] = [];
  const outputValues: { readonly flag: string; readonly index: number }[] = [];
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    const next = arguments_[index + 1];
    if (
      INCUR_BUILTIN_FLAGS.has(argument) ||
      // A following value belongs to a command-local `--version` option.
      (argument === "--version" && (next === undefined || next.startsWith("-")))
    )
      continue;
    if (VALUED_OUTPUT_FLAGS.has(argument) && next) {
      outputValues.push({ flag: argument, index: index + 1 });
      index += 1;
      continue;
    }
    command.push(argument);
  }
  return { command, outputValues };
};

/**
 * Route the root update alias and split `--flag=value` output forms. Incur reads these
 * flags only in spaced form, so `--format=json` otherwise reaches the command
 * parser and fails as an unknown flag. Command options accept both forms.
 */
export const normalizeCliArguments = (
  arguments_: readonly string[],
): string[] => {
  const normalized: string[] = [];
  const updates = new Set<number>();
  let rootUpdate = true;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    if (VALUED_OUTPUT_FLAGS.has(argument) && arguments_[index + 1]) {
      // Incur consumes a nonempty spaced value before looking for more flags.
      // Its contents belong to that option, even when they look like a flag.
      normalized.push(argument, arguments_[index + 1]!);
      index += 1;
      continue;
    }
    const separator = argument.indexOf("=");
    const flag = argument.slice(0, separator);
    if (separator >= 0 && VALUED_OUTPUT_FLAGS.has(flag))
      normalized.push(flag, argument.slice(separator + 1));
    else {
      if (argument === "--update") updates.add(normalized.length);
      else if (!ROOT_UPDATE_OUTPUT_FLAGS.has(argument)) rootUpdate = false;
      normalized.push(argument);
    }
  }
  // Output option values were consumed above; flag-shaped data is never an alias.
  // Help/check/command/unknown tokens retain Incur's parsing and precedence.
  return rootUpdate && updates.size > 0
    ? ["update", ...normalized.filter((_, index) => !updates.has(index))]
    : normalized;
};

export type CliOutputArgumentValidation =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly format: StructuredOutputFormat;
      readonly code:
        | "UNSUPPORTED_OUTPUT_COMBINATION"
        | "INVALID_OUTPUT_FILTER"
        | "MISSING_OUTPUT_VALUE";
      readonly message: string;
    };

interface CliOutputControls {
  readonly filterOutput: string | undefined;
  readonly format: string;
  /** Whether `--json` or `--format` selected the format, rather than the default. */
  readonly formatExplicit: boolean;
  readonly fullOutput: boolean;
  /** First valued output flag that Incur skips because it has no value. */
  readonly missingValue: string | undefined;
  readonly parseError: boolean;
  readonly tokenCount: boolean;
  readonly tokenWindow: boolean;
  readonly tokenLimit: number | undefined;
  readonly tokenOffset: number | undefined;
}

/** Parsed output controls and the decisions shared by every executable consumer. */
export interface ParsedCliOutputArguments extends CliOutputControls {
  readonly validation: CliOutputArgumentValidation;
  readonly versionReportFormat: CliOutputFormat | undefined;
}

/** Read effective Incur output controls at the executable boundary. */
export const parseCliOutputArguments = (
  arguments_: readonly string[],
): ParsedCliOutputArguments => {
  let format: string = "toon";
  let rootVersion = false;
  let versionEligible = true;
  let formatExplicit = false;
  let filterOutput: string | undefined;
  let fullOutput = false;
  let missingValue: string | undefined;
  let tokenCount = false;
  let tokenLimit: number | undefined;
  let tokenOffset: number | undefined;
  const parsed = (parseError: boolean): ParsedCliOutputArguments => {
    const controls: CliOutputControls = {
      filterOutput,
      format,
      formatExplicit,
      fullOutput,
      missingValue,
      parseError,
      tokenCount,
      tokenWindow:
        !parseError && (tokenLimit !== undefined || tokenOffset !== undefined),
      tokenLimit: parseError ? undefined : tokenLimit,
      tokenOffset: parseError ? undefined : tokenOffset,
    };
    return {
      ...controls,
      validation: validateCliOutputControls(controls),
      versionReportFormat:
        rootVersion &&
        versionEligible &&
        formatExplicit &&
        !parseError &&
        missingValue === undefined &&
        isCliOutputFormat(format)
          ? format
          : undefined,
    };
  };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    // Only these flags can accompany a formatted root version request.
    // Valued output flags consume their data below before the next iteration.
    if (argument === "--version") {
      const next = arguments_[index + 1];
      if (next === undefined || next.startsWith("-")) rootVersion = true;
      else versionEligible = false;
    } else if (argument !== "--json" && argument !== "--format")
      versionEligible = false;
    // Incur scans builtins across `--` and reads spaced value forms, which
    // normalizeCliArguments has produced. Mirror those effective values.
    if (argument === "--json") {
      format = "json";
      formatExplicit = true;
      continue;
    }
    if (argument === "--format") {
      const value = arguments_[index + 1];
      if (value) {
        // Incur stops parsing at an invalid format before applying any later
        // output controls. Let it report that malformed flag itself.
        if (cliOutputValueRejection(argument, value) !== undefined)
          return parsed(true);
        format = value;
        formatExplicit = true;
        index += 1;
      } else missingValue ??= argument;
      continue;
    }
    if (argument === "--filter-output") {
      if (arguments_[index + 1]) {
        filterOutput = arguments_[index + 1];
        index += 1;
      } else missingValue ??= argument;
      continue;
    }
    if (argument === "--token-limit" || argument === "--token-offset") {
      const value = arguments_[index + 1];
      if (value) {
        if (cliOutputValueRejection(argument, value) !== undefined)
          return parsed(true);
        const numericValue = Number(value);
        if (argument === "--token-limit") tokenLimit = numericValue;
        else tokenOffset = numericValue;
        index += 1;
      } else missingValue ??= argument;
      continue;
    }
    if (argument === "--full-output") fullOutput = true;
    if (argument === "--token-count") tokenCount = true;
  }
  return parsed(false);
};

/** Reject slices that cannot advance within Incur's comma-delimited paths. */
const hasUnclosedFilterSlice = (expression: string): boolean => {
  let depth = 0;
  let unclosed = false;
  for (const character of expression) {
    if (character === "[") {
      depth += 1;
      unclosed = true;
    } else if (character === "]") {
      depth -= 1;
      // Incur consumes everything through the next closing bracket, including
      // nested opening brackets. Do not impose a different filter grammar.
      unclosed = false;
    } else if (character === "," && depth === 0 && unclosed) return true;
  }
  return unclosed;
};

/** Name a valued output flag that was given without a value. */
export const missingCliOutputValueMessage = (flag: string): string =>
  `${flag} requires a value, as in ${flag} <value> or ${flag}=<value>.`;

/** Reject output controls that cannot safely produce a complete result. */
const validateCliOutputControls = ({
  filterOutput,
  format,
  missingValue,
  parseError,
  tokenWindow,
}: CliOutputControls): CliOutputArgumentValidation => {
  if (parseError) return { ok: true };
  if (filterOutput !== undefined && hasUnclosedFilterSlice(filterOutput))
    return {
      ok: false,
      format: format === "yaml" || format === "jsonl" ? format : "json",
      code: "INVALID_OUTPUT_FILTER",
      message:
        "The --filter-output expression has a slice without a closing ]. Close the slice or remove --filter-output.",
    };
  if (
    tokenWindow &&
    (format === "json" || format === "jsonl" || format === "yaml")
  )
    return {
      ok: false,
      format,
      code: "UNSUPPORTED_OUTPUT_COMBINATION",
      message: UNSUPPORTED_OUTPUT_COMBINATION_MESSAGE,
    };
  // Incur skips a valued flag without a value and then reports the flag
  // itself as unknown. Name the missing value instead.
  if (missingValue !== undefined)
    return {
      ok: false,
      format: format === "yaml" || format === "jsonl" ? format : "json",
      code: "MISSING_OUTPUT_VALUE",
      message: missingCliOutputValueMessage(missingValue),
    };
  return { ok: true };
};

/** Preserve a complete document when Incur filters the entire result away. */
export const renderEmptyFilteredCliOutput = ({
  filterOutput,
  format,
  parseError,
}: ParsedCliOutputArguments): string | undefined => {
  if (parseError) return undefined;
  if (
    filterOutput &&
    (format === "json" || format === "jsonl" || format === "yaml")
  )
    return "{}\n";
  return undefined;
};

/** Render one complete structured error before command execution. */
export const renderCliOutputArgumentError = (
  error: Exclude<CliOutputArgumentValidation, { readonly ok: true }>,
): string => {
  const value = {
    ok: false,
    error: { code: error.code, message: error.message },
  };
  if (error.format === "yaml")
    return `ok: false\nerror:\n  code: ${error.code}\n  message: ${JSON.stringify(error.message)}\n`;
  return `${JSON.stringify(error.format === "jsonl" ? jsonLinesErrorRecord(value) : value)}\n`;
};

/**
 * Render the version report for a formatted root `--version` request, or
 * return undefined so Incur prints the bare version or handles the request.
 */
export const renderVersionReport = (
  { versionReportFormat: format }: ParsedCliOutputArguments,
  host: VersionReportHost,
  stdoutIsTerminal: boolean,
): string | undefined => {
  return format === undefined
    ? undefined
    : renderCliDocument(versionReport(host), format, stdoutIsTerminal);
};
