import { jsonObjectSchema } from "../domain/jsonValue.js";
import { enhancedInputSchemas } from "./enhancedInputs.js";
import { TOOL_EXAMPLE_OVERRIDES } from "./toolContractExamples.js";
import type { ToolContract } from "./toolContractTypes.js";
import { toolContractMetadata } from "./toolEffects.js";
import { enhancedOutputSchemas } from "./toolOutputSchemas.js";
import { requireOutputSchema } from "./toolOutputSchemaPrimitives.js";

type FunctionWorkflowName = "analyze_function" | "inspect_native_api";

const functionWorkflow = <Name extends FunctionWorkflowName>(
  name: Name,
  description: string,
) => {
  const inputSchema = enhancedInputSchemas[name];
  const outputSchema = requireOutputSchema(enhancedOutputSchemas, name);
  return {
    name,
    ...toolContractMetadata(name),
    description,
    kind: "enhanced",
    inputSchema,
    outputSchema,
    examples: [
      {
        title: `Example ${name.replaceAll("_", " ")} request`,
        input: jsonObjectSchema.parse(
          inputSchema.parse(TOOL_EXAMPLE_OVERRIDES[name] ?? {}),
        ),
      },
    ],
  } satisfies ToolContract<Name, typeof inputSchema, typeof outputSchema>;
};

/** Function dossier and native API reconstruction workflow contracts. */
export const FUNCTION_WORKFLOW_TOOL_CONTRACTS = [
  functionWorkflow(
    "analyze_function",
    "Use for a specific native function when you need its behavior and surrounding evidence in one call. Pass a procedure symbol/name or provider-returned address, typically selected from search_procedures or list_procedures. Returns identity, provider-specific pseudocode and assembly, comments, calls, references, referenced strings/names, local CFG blocks, and available native API boundary observations. For only one facet, use the focused procedure tool; for structured native API reconstruction, use inspect_native_api.",
  ),
  functionWorkflow(
    "inspect_native_api",
    "Use after identifying a function that calls or implements a native API boundary when you need structured return/parameter types and dispatch evidence. Pass its procedure symbol/name or provider-returned address. Returns confidence, evidence, jump-table dispatch/data/target mappings, unsupported branches, and residual unknowns; use analyze_function for a general function dossier.",
  ),
] as const satisfies readonly ToolContract[];
