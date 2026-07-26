import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "prettier";

import { TOOL_CONTRACTS } from "../dist/contracts/toolContracts.js";
import { MANAGED_WORKFLOW_TOOL_CONTRACTS } from "../dist/contracts/managedWorkflowToolContracts.js";
import { ArtifactProvider } from "../dist/artifacts/ArtifactProvider.js";
import { ManagedStaticProvider } from "../dist/dotnet/ManagedStaticProvider.js";
import { NativeMacOSProvider } from "../dist/native/NativeMacOSProvider.js";
import { toolRegistrationOptions } from "../dist/server/toolRegistrationOptions.js";
import { ensureGeneratedFile } from "./lib/generated-file.mjs";

const arguments_ = new Set(process.argv.slice(2));
for (const argument of arguments_)
  if (argument !== "--check")
    throw new Error(`Unknown MCP tool catalog option: ${argument}`);

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sessionToolNames = new Set([
  ...TOOL_CONTRACTS.filter(({ kind }) => kind === "session").map(
    ({ name }) => name,
  ),
  ...MANAGED_WORKFLOW_TOOL_CONTRACTS.map(({ name }) => name),
]);
const catalog = TOOL_CONTRACTS.map((contract) => {
  const options = toolRegistrationOptions(contract);
  return {
    name: contract.name,
    analysisOperation: [
      "official-proxy",
      "enhanced",
      "native-provider",
      "artifact-provider",
      "managed-provider",
    ].includes(contract.kind)
      ? contract.name
      : null,
    title: options.title,
    description: options.description,
    kind: contract.kind,
    requiresSession: sessionToolNames.has(contract.name),
    inputSchema: options.inputSchema["~standard"].jsonSchema.input({
      target: "draft-2020-12",
    }),
    outputSchema: options.outputSchema["~standard"].jsonSchema.output({
      target: "draft-2020-12",
    }),
    annotations: options.annotations,
    effects: contract.effects,
  };
});
const auxiliaryProviders = [
  new ArtifactProvider(false, false),
  new NativeMacOSProvider(),
  new ManagedStaticProvider(),
].map((provider) => ({
  identity: provider.identity(),
  capabilities: provider.capabilities(),
}));
const source = await format(
  `import type { ToolAnnotations } from "@modelcontextprotocol/server";
import type {
  CapabilityDescriptor,
  ProviderIdentity,
} from "./application/AnalysisProvider.js";
import type { ToolKind } from "./contracts/toolContractTypes.js";
import type { ToolEffects } from "./contracts/toolEffects.js";

/** Generated from TOOL_CONTRACTS; do not edit. */
// prettier-ignore
export const GENERATED_MCP_TOOL_CATALOG: readonly {
  readonly name: string;
  readonly analysisOperation: CapabilityDescriptor["operation"] | null;
  readonly title: string;
  readonly description: string;
  readonly kind: ToolKind;
  readonly requiresSession: boolean;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly outputSchema: Readonly<Record<string, unknown>>;
  readonly annotations: ToolAnnotations;
  readonly effects: ToolEffects;
}[] = ${JSON.stringify(catalog)};

/** Generated lightweight metadata for lazily loaded auxiliary providers. */
// prettier-ignore
export const GENERATED_AUXILIARY_PROVIDERS: readonly {
  readonly identity: ProviderIdentity;
  readonly capabilities: readonly CapabilityDescriptor[];
}[] = ${JSON.stringify(auxiliaryProviders)};
`,
  { parser: "typescript" },
);

await ensureGeneratedFile({
  path: join(root, "src/generatedMcpToolCatalog.ts"),
  source,
  check: arguments_.has("--check"),
  generateCommand: "npm run mcp-catalog:generate",
});
