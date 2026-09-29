import { describe, expect, it } from "vitest";

import { parseConfig } from "./config.js";

describe("passive browser observation policy", () => {
  it("requires both endpoint and origin scopes when enabled", () => {
    expect(
      parseConfig({
        REA_BROWSER_OBSERVE_ENABLED: "true",
        REA_BROWSER_ALLOWED_ORIGINS_JSON: '["https://app.example.test"]',
      }).ok,
    ).toBe(false);
    expect(
      parseConfig({
        REA_BROWSER_OBSERVE_ENABLED: "true",
        REA_BROWSER_CDP_ENDPOINTS_JSON: '["http://127.0.0.1:9222"]',
      }).ok,
    ).toBe(false);
  });

  it("parses one enabled policy and drops inactive settings", () => {
    expect(
      parseConfig({
        REA_BROWSER_OBSERVE_ENABLED: "true",
        REA_BROWSER_CDP_ENDPOINTS_JSON: '["http://127.0.0.1:9222"]',
        REA_BROWSER_ALLOWED_ORIGINS_JSON: '["https://app.example.test"]',
      }),
    ).toMatchObject({
      ok: true,
      value: {
        browserObservationPolicy: {
          status: "enabled",
          cdpEndpoints: ["http://127.0.0.1:9222"],
          allowedOrigins: ["https://app.example.test"],
        },
      },
    });
    expect(
      parseConfig({
        REA_BROWSER_CDP_ENDPOINTS_JSON: '["http://127.0.0.1:9222"]',
        REA_BROWSER_ALLOWED_ORIGINS_JSON: '["https://ignored.example.test"]',
      }),
    ).toMatchObject({
      ok: true,
      value: { browserObservationPolicy: { status: "disabled" } },
    });
  });
});

describe("passive Electron observation policy", () => {
  it("enables the capability without endpoint or path allowlists", () => {
    expect(parseConfig({ REA_ELECTRON_OBSERVE_ENABLED: "true" })).toMatchObject(
      {
        ok: true,
        value: {
          electronObservationPolicy: { status: "enabled" },
        },
      },
    );
  });
});

describe("passive V8 Inspector observation policy", () => {
  it("enables the capability without endpoint, file-root, or origin allowlists", () => {
    expect(
      parseConfig({ REA_V8_INSPECTOR_OBSERVE_ENABLED: "true" }),
    ).toMatchObject({
      ok: true,
      value: {
        v8InspectorObservationPolicy: { status: "enabled" },
      },
    });
  });
});
