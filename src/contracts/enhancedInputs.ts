import { z } from "zod";

const traceLiteralInputSchema = z.strictObject({
  query: z.string().min(1),
  case_sensitive: z.boolean().default(false),
  unknown_registry_approved: z
    .literal(true)
    .optional()
    .describe("Explicit approval to record bounded residuals durably"),
});

/** Input schemas shared by MCP registration and enhanced application dispatch. */
export const enhancedInputSchemas = {
  swift_classes: z.strictObject({ pattern: z.string().default("") }),
  get_objc_classes: z.strictObject({ pattern: z.string().default("") }),
  get_objc_protocols: z.strictObject({}),
  batch_decompile: z.strictObject({
    addresses: z
      .array(z.string().describe("A provider-normalized procedure address"))
      .default([]),
  }),
  get_call_graph: z.strictObject({
    address: z.string().describe("A provider-normalized procedure address"),
    direction: z.enum(["forward", "backward"]).default("forward"),
  }),
  analyze_swift_types: z.strictObject({}),
  find_xrefs_to_name: z.strictObject({ name: z.string() }),
  binary_overview: z.strictObject({}),
  analyze_function: z.strictObject({
    procedure: z.string().describe("A procedure name or address"),
  }),
  inspect_native_api: z.strictObject({
    procedure: z.string().describe("A procedure name or address"),
    unknown_registry_approved: z
      .literal(true)
      .optional()
      .describe(
        "Explicit approval to record unsupported native API branches durably",
      ),
  }),
  trace_feature: traceLiteralInputSchema,
  find_code_for_string: traceLiteralInputSchema,
  trace_call_path: z.strictObject({
    start: z.string().describe("A provider-normalized procedure address"),
    goal: z
      .string()
      .describe("An optional provider-normalized destination address")
      .optional(),
    direction: z.enum(["forward", "backward"]).default("forward"),
    unknown_registry_approved: z
      .literal(true)
      .optional()
      .describe(
        "Explicit approval to record unresolved provider results durably",
      ),
  }),
} as const;

export type EnhancedToolName = keyof typeof enhancedInputSchemas;
