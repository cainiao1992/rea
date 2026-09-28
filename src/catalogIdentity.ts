import { createHash } from "node:crypto";

import canonicalize from "canonicalize";
import { z } from "zod";

import { PROMPT_CONTRACTS } from "./contracts/promptContracts.js";
import { TOOL_CONTRACTS } from "./contracts/toolContracts.js";
import { CLI_COMMAND_NAMES } from "./cliCommandNames.js";

export { CLI_COMMAND_NAMES } from "./cliCommandNames.js";

const toolCatalog = TOOL_CONTRACTS.map((contract) => ({
  name: contract.name,
  title: contract.title,
  surface: contract.kind,
  description: contract.description,
  effects: { ...contract.effects },
  annotations: contract.annotations,
  input_schema: {
    type: "object",
    ...z.toJSONSchema(contract.inputSchema, {
      unrepresentable: "any",
    }),
  },
  output_schema: {
    type: "object",
    ...z.toJSONSchema(contract.outputSchema, {
      unrepresentable: "any",
    }),
  },
})).sort((left, right) => left.name.localeCompare(right.name));

const promptCatalog = PROMPT_CONTRACTS.map((contract) => ({
  name: contract.name,
  title: contract.title,
  description: contract.description,
  arguments: contract.arguments,
  steps: contract.steps,
})).sort((left, right) => left.name.localeCompare(right.name));

const digest = (value: unknown): string => {
  const encoded = canonicalize(value);
  if (encoded === undefined)
    throw new TypeError("Catalog is not canonical JSON");
  return createHash("sha256").update(encoded).digest("hex");
};

/** Stable, schema-sensitive identity for every public REA surface. */
export const CATALOG_IDENTITY = {
  counts: {
    cli_commands: CLI_COMMAND_NAMES.length,
    mcp_tools: toolCatalog.length,
    mcp_prompts: promptCatalog.length,
  },
  digests: {
    tools_sha256: digest(toolCatalog),
    prompts_sha256: digest(promptCatalog),
    combined_sha256: digest({
      cli: CLI_COMMAND_NAMES,
      tools: toolCatalog,
      prompts: promptCatalog,
    }),
  },
  tools: toolCatalog.map(({ name, surface, effects, annotations }) => ({
    name,
    surface,
    effects,
    annotations: {
      read_only: annotations.readOnlyHint ?? false,
      destructive: annotations.destructiveHint ?? false,
      idempotent: annotations.idempotentHint ?? false,
      open_world: annotations.openWorldHint ?? true,
    },
  })),
} as const;
