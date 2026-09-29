import type { ToolContract } from "./toolContracts.js";
import { toolContractMetadata } from "./toolEffects.js";
import { evidenceResultOf } from "./toolOutputSchemas.js";
import { browserScenarioInputSchema } from "../domain/browserScenario.js";
import { browserScenarioCaptureSchema } from "../domain/browserScenarioCapture.js";
import type { JsonValue } from "../domain/jsonValue.js";

const example: Record<string, JsonValue> = {
  browser: {
    mode: "launch",
    executable_path: "/opt/chromium/chrome",
    headless: true,
    user_data: "temporary-owned",
    cleanup: "close-and-delete-profile",
  },
  start_url: { url: "https://app.example.test/", query: [] },
  allowed_origins: ["https://app.example.test"],
  actions: [
    {
      step_id: "settle",
      action: "wait_for_timeout",
      duration_ms: 250,
    },
  ],
};

/** Controlled browser scenario contract shared by MCP and catalog generation. */
export const BROWSER_SCENARIO_TOOL_CONTRACTS = [
  {
    name: "capture_browser_scenario",
    ...toolContractMetadata("capture_browser_scenario"),
    description:
      "Run a controlled browser scenario when passive observation cannot exercise the application. Choose launch mode with an approved executable or connect mode with an approved loopback CDP target, declare the exact start origin scope, and provide explicit actions. Environment, empty storage, disabled request replay, redaction, and a URL-only final capture have safe defaults; declare secrets, initial storage, exact request replay, or additional retained artifacts only when needed. Provider-owned duration, action, and navigation timeouts remain fixed. There are no action, secret, storage, route, event, frame, DOM, network, or cumulative metadata count caps; every observation is returned inline. Oversized text or screenshot artifacts fail with a payload-limit error instead of being silently omitted.",
    kind: "browser-provider",
    inputSchema: browserScenarioInputSchema,
    outputSchema: evidenceResultOf(browserScenarioCaptureSchema),
    examples: [
      { title: "Capture a deterministic browser scenario", input: example },
    ],
  },
] as const satisfies readonly ToolContract[];
