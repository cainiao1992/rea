import type { ToolContract } from "./toolContracts.js";
import { toolContractMetadata } from "./toolEffects.js";
import { evidenceResultOf } from "./toolOutputSchemas.js";
import {
  javascriptRuntimeObservationSchema,
  javascriptRuntimeTargetListSchema,
  listJavaScriptRuntimeTargetsInputSchema,
  observeJavaScriptRuntimeInputSchema,
} from "../domain/javascriptRuntimeObservation.js";

const root = "/opt/example-app";
const endpoint = "http://127.0.0.1:9229";

/** Passive Node/Electron V8 Inspector discovery and observation contracts. */
export const JAVASCRIPT_RUNTIME_OBSERVATION_TOOL_CONTRACTS = [
  {
    name: "list_javascript_runtime_targets",
    ...toolContractMetadata("list_javascript_runtime_targets"),
    description:
      "List attachable Node/Electron V8 Inspector targets from one approved literal-loopback endpoint. Only targets inside exact canonical file roots or exact HTTP(S) origins are retained; excluded target locations never enter Evidence.",
    kind: "runtime-provider",
    inputSchema: listJavaScriptRuntimeTargetsInputSchema,
    outputSchema: evidenceResultOf(javascriptRuntimeTargetListSchema),
    examples: [
      {
        title: "List approved Node Inspector targets",
        input: {
          inspector_endpoint: endpoint,
          allowed_file_roots: [root],
          allowed_origins: [],
          approved: true,
          offset: 0,
          limit: 100,
        },
      },
    ],
  },
  {
    name: "observe_javascript_runtime",
    ...toolContractMetadata("observe_javascript_runtime"),
    description:
      "Attach passively to one exact approved Node/Electron V8 Inspector target and capture bounded Debugger.scriptParsed plus Runtime execution-context events. REA sends only Runtime.enable and Debugger.enable: it never evaluates, pauses, resumes, reads source, or instruments the target. require/import edges, EventEmitter activity, and Electron IPC remain explicit unknowns; reconcile the returned Evidence with static Application Graph Evidence using reconcile_javascript_runtime.",
    kind: "runtime-provider",
    inputSchema: observeJavaScriptRuntimeInputSchema,
    outputSchema: evidenceResultOf(javascriptRuntimeObservationSchema),
    examples: [
      {
        title: "Observe one approved Node runtime",
        input: {
          inspector_endpoint: endpoint,
          allowed_file_roots: [root],
          allowed_origins: [],
          target_id: "TARGET_ID_FROM_LIST_JAVASCRIPT_RUNTIME_TARGETS",
          runtime_kind: "node",
          approved: true,
          observation_ms: 100,
          limits: {
            max_events: 10_000,
            max_scripts: 2_000,
            max_execution_contexts: 1_000,
            max_location_bytes: 16_384,
            max_total_metadata_bytes: 4_194_304,
          },
        },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
