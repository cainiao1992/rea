import { z } from "zod";

const positiveSafeInteger = z.number().int().safe().positive();

export const DEFAULT_BROWSER_SCENARIO_CAPTURE_LIMITS = {
  max_events: 10_000,
  max_event_allocation_bytes: 4 * 1024 * 1024,
  max_total_event_allocation_bytes: 16 * 1024 * 1024,
  max_network_transactions: 1024,
  max_network_body_bytes: 64 * 1024,
  max_network_body_allocation_bytes: 1024 * 1024,
  max_network_header_allocation_bytes: 1024 * 1024,
  max_network_metadata_allocation_bytes: 1024 * 1024,
} as const;

/** Caller-selected retained-output budgets; byte values are allocation-cost estimates. */
export const browserScenarioCaptureLimitsSchema = z.strictObject({
  max_events: positiveSafeInteger.default(
    DEFAULT_BROWSER_SCENARIO_CAPTURE_LIMITS.max_events,
  ),
  max_event_allocation_bytes: positiveSafeInteger.default(
    DEFAULT_BROWSER_SCENARIO_CAPTURE_LIMITS.max_event_allocation_bytes,
  ),
  max_total_event_allocation_bytes: positiveSafeInteger.default(
    DEFAULT_BROWSER_SCENARIO_CAPTURE_LIMITS.max_total_event_allocation_bytes,
  ),
  max_network_transactions: positiveSafeInteger.default(
    DEFAULT_BROWSER_SCENARIO_CAPTURE_LIMITS.max_network_transactions,
  ),
  max_network_body_bytes: positiveSafeInteger.default(
    DEFAULT_BROWSER_SCENARIO_CAPTURE_LIMITS.max_network_body_bytes,
  ),
  max_network_body_allocation_bytes: positiveSafeInteger.default(
    DEFAULT_BROWSER_SCENARIO_CAPTURE_LIMITS.max_network_body_allocation_bytes,
  ),
  max_network_header_allocation_bytes: positiveSafeInteger.default(
    DEFAULT_BROWSER_SCENARIO_CAPTURE_LIMITS.max_network_header_allocation_bytes,
  ),
  max_network_metadata_allocation_bytes: positiveSafeInteger.default(
    DEFAULT_BROWSER_SCENARIO_CAPTURE_LIMITS.max_network_metadata_allocation_bytes,
  ),
});

export type BrowserScenarioCaptureLimits = z.infer<
  typeof browserScenarioCaptureLimitsSchema
>;
