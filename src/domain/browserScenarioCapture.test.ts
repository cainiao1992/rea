import { createHash } from "node:crypto";

import { expect, it } from "vitest";

import { sanitizeBrowserUrl } from "./browserObservation.js";
import {
  browserScenarioCompletenessSchema,
  browserScenarioEventSchema,
  browserStepArtifactsSchema,
} from "./browserScenarioCaptureValues.js";

const networkEvent = {
  sequence: 1,
  step_index: 0,
  method: "GET",
  url: sanitizeBrowserUrl("https://example.test/resource"),
  resource_type: "document",
  header_names: [],
} as const;

it("parses each network outcome without contradictory status or failure data", () => {
  expect(
    browserScenarioEventSchema.safeParse({
      ...networkEvent,
      kind: "response",
      status: null,
      failure: null,
    }).success,
  ).toBe(false);
  expect(
    browserScenarioEventSchema.safeParse({
      ...networkEvent,
      kind: "request-failed",
      status: 500,
      failure: "connection reset",
    }).success,
  ).toBe(false);
});

it("keeps WebSocket payload representation tied to its payload type", () => {
  const frame = {
    sequence: 1,
    step_index: 0,
    kind: "websocket-frame-received",
    url: sanitizeBrowserUrl("https://example.test/socket"),
    payload_bytes: 3,
    truncated: false,
  } as const;
  expect(
    browserScenarioEventSchema.safeParse({
      ...frame,
      payload_type: "binary",
      payload_text: "abc",
    }).success,
  ).toBe(false);
  expect(
    browserScenarioEventSchema.safeParse({
      ...frame,
      payload_type: "text",
      payload_text: "abc",
    }).success,
  ).toBe(true);
});

it("does not attach a content digest to redacted storage secrets", () => {
  expect(
    browserStepArtifactsSchema.safeParse({
      screenshot: { state: "not_requested" },
      dom: { state: "not_requested" },
      accessibility: { state: "not_requested" },
      url: { state: "not_requested" },
      history: { state: "not_requested" },
      storage: {
        state: "captured",
        value: {
          cookies: [],
          local_storage: [
            {
              name: "session",
              value_state: "redacted-secret",
              value_sha256: "a".repeat(64),
            },
          ],
          session_storage: [],
        },
      },
    }).success,
  ).toBe(false);
});

it("accepts complete storage, history, and text artifacts beyond former caps", () => {
  const text = "x".repeat(1_048_577);
  const fingerprint = {
    name: "entry",
    value_state: "hashed",
    value_sha256: "a".repeat(64),
  } as const;
  const parsed = browserStepArtifactsSchema.safeParse({
    screenshot: { state: "not_requested" },
    dom: {
      state: "captured",
      value: {
        sha256: createHash("sha256").update(text).digest("hex"),
        bytes: Buffer.byteLength(text),
        text,
      },
    },
    accessibility: { state: "not_requested" },
    url: { state: "not_requested" },
    history: {
      state: "captured",
      value: {
        length: 257,
        current_url: sanitizeBrowserUrl("https://example.test/"),
        navigation_entries: Array.from({ length: 257 }, () => ({
          type: "navigate",
          name: sanitizeBrowserUrl("https://example.test/"),
        })),
      },
    },
    storage: {
      state: "captured",
      value: {
        cookies: Array.from({ length: 513 }, () => ({
          name: fingerprint.name,
          domain: "example.test",
          path: "/",
          secure: true,
          http_only: false,
          same_site: "Lax",
          value_state: fingerprint.value_state,
          value_sha256: fingerprint.value_sha256,
        })),
        local_storage: Array.from({ length: 513 }, () => fingerprint),
        session_storage: Array.from({ length: 513 }, () => fingerprint),
      },
    },
  });

  expect(parsed.success).toBe(true);
});

it("derives equality eligibility from exact completeness state", () => {
  expect(
    browserScenarioCompletenessSchema.safeParse({
      status: "complete",
      equality_eligible: false,
      missing_sections: [],
      truncated_sections: [],
    }).success,
  ).toBe(false);
  expect(
    browserScenarioCompletenessSchema.safeParse({
      status: "incomplete",
      equality_eligible: false,
      missing_sections: ["dom"],
      truncated_sections: ["events"],
    }).success,
  ).toBe(false);
});
