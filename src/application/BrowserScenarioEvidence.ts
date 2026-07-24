import type { ProviderIdentity } from "./AnalysisProvider.js";
import type { BrowserScenario } from "../domain/browserScenario.js";
import type { BrowserScenarioCapture } from "../domain/browserScenarioCapture.js";
import { sanitizeBrowserUrl } from "../domain/browserObservation.js";
import {
  createEvidence,
  type Evidence,
  type EvidenceObservation,
} from "../domain/evidence.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import { digestJson } from "./JavaScriptReplayPlanning.js";

const browserScenarioParameters = (
  scenario: BrowserScenario,
): EvidenceObservation["parameters"] => ({
  scenario_sha256: digestJson(scenario),
  browser_mode: scenario.browser.mode,
  start_url: sanitizeBrowserUrl(scenario.start_url.url),
  allowed_origins: scenario.allowed_origins,
  actions: scenario.actions.map(({ step_id, action }) => ({
    step_id,
    action,
  })),
  secret_declarations: scenario.secrets.map(
    ({ secret_id, environment_variable, purpose, redaction }) => ({
      secret_id,
      environment_variable,
      purpose,
      redaction,
    }),
  ),
  capture: scenario.capture,
  limits: scenario.limits,
});

/** Create Evidence v2 without retaining resolved scenario secret values. */
export const createBrowserScenarioEvidence = (
  scenario: BrowserScenario,
  capture: BrowserScenarioCapture,
  provider: ProviderIdentity,
): Evidence =>
  createEvidence(undefined, provider, {
    predicateType: "rea.browser-scenario-capture/v1",
    operation: "capture_browser_scenario",
    parameters: browserScenarioParameters(scenario),
    result: jsonValueSchema.parse(capture),
    confidence: "observed",
    authority: "controlled-replay",
    environment: {
      id: `${capture.browser.product}@${capture.browser.version}`,
      platform: process.platform,
      architecture: process.arch,
      isolation:
        capture.browser.process_ownership === "provider-owned"
          ? "process"
          : "none",
    },
    limitations: capture.limitations,
  });
