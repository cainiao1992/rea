import type { ToolContract } from "./toolContracts.js";
import { toolContractMetadata } from "./toolEffects.js";
import { evidenceResultOf } from "./toolOutputSchemas.js";
import { browserScenarioSchema } from "../domain/browserScenario.js";
import { browserScenarioCaptureSchema } from "../domain/browserScenarioCapture.js";
import type { JsonValue } from "../domain/jsonValue.js";

const example: Record<string, JsonValue> = {
  schema_version: 1,
  browser: {
    mode: "launch",
    executable_path: "/opt/chromium/chrome",
    headless: true,
    user_data: "temporary-owned",
    cleanup: "close-and-delete-profile",
  },
  start_url: { url: "https://app.example.test/", query: [] },
  allowed_origins: ["https://app.example.test"],
  environment: {
    viewport: { width: 1_280, height: 720, device_scale_factor: 1 },
    locale: "en-US",
    timezone: "UTC",
    color_scheme: "light",
    reduced_motion: "reduce",
    service_workers: "block",
  },
  actions: [
    {
      step_id: "ready",
      action: "wait_for",
      locator: { kind: "test_id", value: "application-ready" },
      state: "visible",
    },
  ],
  storage: { cookies: [], local_storage: [], session_storage: [] },
  request_replay: { mode: "disabled" },
  secrets: [],
  redaction: {
    secret_values: "replace-with-secret-reference",
    query_parameter_names: [],
    header_names: [
      "authorization",
      "cookie",
      "proxy-authorization",
      "set-cookie",
    ],
  },
  capture: {
    after_each_step: ["screenshot", "url", "accessibility"],
    at_end: ["dom", "history", "storage"],
    events: ["console", "page-errors", "network", "websockets"],
  },
  limits: {
    max_duration_ms: 60_000,
    action_timeout_ms: 5_000,
    navigation_timeout_ms: 10_000,
    max_events: 2_000,
    max_frames: 100,
    max_workers: 20,
    max_popups: 10,
    max_websockets: 100,
    max_dom_nodes: 10_000,
    max_accessibility_nodes: 10_000,
    max_screenshots: 16,
    max_screenshot_bytes: 4_194_304,
    max_storage_entries: 256,
    max_total_metadata_bytes: 4_194_304,
  },
  approved: true,
};

/** Controlled browser scenario contract shared by MCP and catalog generation. */
export const BROWSER_SCENARIO_TOOL_CONTRACTS = [
  {
    name: "capture_browser_scenario",
    ...toolContractMetadata("capture_browser_scenario"),
    description:
      "Run one approved, bounded browser scenario through Playwright. Launch mode owns and terminates a temporary browser profile; connect mode attaches to one exact loopback CDP target and disconnects without terminating the external browser. Only the fixed action vocabulary is accepted. Navigation, storage, requests, redirects, secrets, redaction, captures, and limits must be declared before execution. Returns step-indexed Evidence with screenshots, DOM, accessibility, URL/history/storage state, runtime events, explicit missing/truncated sections, and equality eligibility.",
    kind: "browser-provider",
    inputSchema: browserScenarioSchema,
    outputSchema: evidenceResultOf(browserScenarioCaptureSchema),
    examples: [
      { title: "Capture a deterministic browser scenario", input: example },
    ],
  },
] as const satisfies readonly ToolContract[];
