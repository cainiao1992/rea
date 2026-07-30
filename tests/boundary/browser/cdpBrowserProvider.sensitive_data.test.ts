import { expect, it } from "vitest";

import { CdpBrowserProvider } from "../../../src/browser/CdpBrowserProvider.js";
import {
  inspectWebPageInputSchema,
  webPageInspectionSchema,
} from "../../../src/domain/browserObservation.js";
import {
  startFakeCdpBrowser,
  type FakeCdpBrowser,
} from "../../fixtures/fakeCdpBrowser.js";
import { describeBrowser, trackBrowser } from "./cdpBrowserProvider.support.js";

describeBrowser("CdpBrowserProvider: sensitive data 1", () => {
  it("captures bounded passive evidence without retaining sensitive values", async () => {
    const browser = await startFakeCdpBrowser({
      binaryWebSocketEvent: true,
      foreignSessionEvents: true,
      unrelatedWorker: true,
    });
    trackBrowser(browser);
    const provider = new CdpBrowserProvider();
    const result = await provider.inspectPage(
      inspectWebPageInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        approved: true,
        observation_ms: 0,
        include_storage_keys: true,
        include_storage_fingerprints: true,
      }),
    );

    if (!result.ok) throw result.error;
    expect(() => webPageInspectionSchema.parse(result.value)).not.toThrow();
    expect(result.value.frames).toHaveLength(1);
    expect(result.value.dom.nodes).toHaveLength(2);
    expect(result.value.dom.nodes[1]?.attribute_names).toEqual([
      "token",
      "href",
      "rel",
    ]);
    expect(result.value.accessibility).toMatchObject({
      text_capture: {
        status: "not_approved",
        retained_bytes: 0,
      },
      nodes: [expect.objectContaining({ name: null, description: null })],
    });
    expect(result.value.scripts.items).toHaveLength(1);
    expect(result.value.scripts.items[0]?.script_key).toMatch(
      /^scr_[a-f0-9]{64}$/u,
    );
    expect(result.value.scripts.items[0]?.frame_id).toBe("frame-main");
    expect(result.value.scripts.items[0]?.source_map_url).toBe(
      `${browser.allowedOrigin}/app.js.map?token=%5BREDACTED%5D`,
    );
    expect(result.value.scripts.items[0]?.resource_reconciliation).toEqual({
      status: "exact",
      resource_key: result.value.resources[0]?.resource_key,
    });
    expect(result.value.scripts.items[0]?.source).toEqual({
      included: false,
      reason: "source capture was not approved",
    });
    expect(result.value.resources).toHaveLength(1);
    expect(result.value.network.requests).toHaveLength(1);
    expect(result.value.network.requests[0]?.initiator).toEqual({
      type: "script",
      url: `${browser.allowedOrigin}/app.js?caller=%5BREDACTED%5D`,
      line: 3,
      column: 5,
    });
    expect(result.value.network.websocket_events).toEqual([
      {
        request_id: "websocket-1",
        direction: "sent",
        opcode: 1,
        payload_bytes: Buffer.byteLength("websocket-secret"),
        payload_shape: null,
      },
      {
        request_id: "websocket-1",
        direction: "received",
        opcode: 2,
        payload_bytes: 3,
        payload_shape: null,
      },
    ]);
    expect(result.value.console.events[0]?.argument_types).toEqual(["string"]);
    expect(result.value.workers).toHaveLength(1);
    expect(result.value.workers[0]).toMatchObject({
      opener_target_id: "allowed-page",
      parent_frame_id: null,
    });
    expect(result.value.metadata).toMatchObject({
      headers_allowlisted: true,
      responses: [
        {
          content_length: 321,
          content_encoding: "br",
          csp: { nonce_count: 1, hash_count: 1 },
          policies: {
            coop: "same-origin",
            coep: "require-corp",
            permissions_policy_features: ["camera", "geolocation"],
          },
        },
      ],
      dom_urls: [
        {
          attribute: "href",
          url: `${browser.allowedOrigin}/agent?token=%5BREDACTED%5D`,
          destination_scope: "approved",
        },
      ],
      agent_hints: expect.arrayContaining([
        expect.objectContaining({
          mechanism: "link_rel",
          declaration: "mcp service-desc",
        }),
        expect.objectContaining({
          mechanism: "dom_link_rel",
          declaration: "mcp",
        }),
        expect.objectContaining({
          mechanism: "response_header",
          declaration: "x-model-context",
        }),
      ]),
    });
    expect(result.value.storage).toEqual(
      expect.objectContaining({
        local_storage_keys: ["public-key"],
        session_storage_keys: ["public-key"],
        indexed_db_names: ["app-db"],
        cache_names: ["assets-v1"],
        content_fingerprints: expect.arrayContaining([
          expect.objectContaining({ scope: "cookie", complete: true }),
          expect.objectContaining({ scope: "local_storage", complete: true }),
          expect.objectContaining({ scope: "session_storage", complete: true }),
          expect.objectContaining({
            scope: "indexed_db_schema",
            complete: true,
          }),
          expect.objectContaining({
            scope: "indexed_db_record",
            complete: true,
          }),
          expect.objectContaining({ scope: "cache_entry", complete: true }),
        ]),
        fingerprint_algorithm: "sha256",
        fingerprints_complete: true,
        values_redacted: true,
      }),
    );
    expectSensitiveValuesAbsent(result.value, browser);
  });
});

describeBrowser("CdpBrowserProvider: sensitive data 2", () => {
  it("captures only approved redacted console text and value-free payload shapes", async () => {
    const browser = await startFakeCdpBrowser({
      sensitiveShapes: true,
      binaryWebSocketEvent: true,
    });
    trackBrowser(browser);
    const result = await new CdpBrowserProvider().inspectPage(
      inspectWebPageInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        approved: true,
        observation_ms: 0,
        include_console_text: true,
        console_text_approved: true,
        include_json_body_shapes: true,
        json_body_schema_approved: true,
        include_websocket_shapes: true,
        websocket_shape_approved: true,
      }),
    );

    if (!result.ok) throw result.error;
    expect(result.value.console.events[0]?.text_capture).toEqual({
      status: "included",
      values: [
        { argument_index: 0, type: "string", text: "authorization=[REDACTED]" },
        { argument_index: 1, type: "number", text: "42" },
      ],
      retained_bytes: 26,
      truncated_values: 0,
    });
    expect(result.value.network.requests[0]?.body_shapes).toMatchObject({
      status: "included",
      request: {
        root_type: "object",
        properties: expect.arrayContaining([
          expect.objectContaining({ path: "/token", types: ["string"] }),
          expect.objectContaining({
            path: "/filters/active",
            types: ["boolean"],
          }),
        ]),
      },
      response: {
        root_type: "object",
        properties: expect.arrayContaining([
          expect.objectContaining({
            path: "/result/token",
            types: ["string"],
          }),
          expect.objectContaining({ path: "/items/*/id", types: ["number"] }),
        ]),
      },
    });
    expect(result.value.network.websocket_events).toEqual([
      expect.objectContaining({
        opcode: 1,
        payload_shape: expect.objectContaining({
          format: "json",
          json_shape: expect.objectContaining({
            properties: expect.arrayContaining([
              expect.objectContaining({ path: "/token", types: ["string"] }),
            ]),
          }),
        }),
      }),
      expect.objectContaining({
        opcode: 2,
        payload_shape: {
          format: "binary",
          json_shape: null,
          truncated: false,
        },
      }),
    ]);
    const serialized = JSON.stringify(result.value);
    for (const secret of [
      "request-body-secret",
      "response-body-secret",
      "websocket-secret",
      "console-secret",
      "object-secret",
    ])
      expect(serialized).not.toContain(secret);
    const methods = browser.commands.map(({ method }) => method);
    expect(methods).toContain("Network.getResponseBody");
    expect(methods).not.toContain("Runtime.getProperties");
    expect(methods).not.toContain("Runtime.callFunctionOn");
  });
});

describeBrowser("CdpBrowserProvider: sensitive data 3", () => {
  it("reports independent sensitive-capture truncation at aggregate byte limits", async () => {
    const browser = await startFakeCdpBrowser({ sensitiveShapes: true });
    trackBrowser(browser);
    const result = await new CdpBrowserProvider().inspectPage(
      inspectWebPageInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        approved: true,
        observation_ms: 0,
        include_console_text: true,
        console_text_approved: true,
        include_json_body_shapes: true,
        json_body_schema_approved: true,
        include_websocket_shapes: true,
        websocket_shape_approved: true,
        limits: {
          max_console_text_field_bytes: 5,
          max_total_console_text_bytes: 5,
          max_json_body_bytes: 10,
          max_total_json_body_bytes: 10,
          max_websocket_shape_bytes: 5,
          max_total_websocket_shape_bytes: 5,
        },
      }),
    );

    if (!result.ok) throw result.error;
    expect(result.value.console.events[0]?.text_capture).toEqual({
      status: "truncated",
      values: [{ argument_index: 0, type: "string", text: "autho" }],
      retained_bytes: 5,
      truncated_values: 2,
    });
    expect(result.value.network.requests[0]?.body_shapes.status).toBe(
      "truncated",
    );
    expect(result.value.network.websocket_events[0]?.payload_shape).toEqual({
      format: "text",
      json_shape: null,
      truncated: true,
    });
    expect(result.value.completeness.truncated_sections).toEqual(
      expect.arrayContaining([
        "console_text",
        "json_body_shapes",
        "websocket_shapes",
      ]),
    );
  });

  it("fails closed on malformed approved response and binary payload encodings", async () => {
    const browser = await startFakeCdpBrowser({
      invalidResponseBodyBase64: true,
      binaryWebSocketEvent: true,
      invalidBinaryWebSocketEvent: true,
    });
    trackBrowser(browser);
    const result = await new CdpBrowserProvider().inspectPage(
      inspectWebPageInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        approved: true,
        observation_ms: 0,
        include_json_body_shapes: true,
        json_body_schema_approved: true,
        include_websocket_shapes: true,
        websocket_shape_approved: true,
      }),
    );

    if (!result.ok) throw result.error;
    expect(result.value.network.requests[0]?.body_shapes).toMatchObject({
      status: "partial",
      request: expect.any(Object),
      response: null,
    });
    expect(result.value.network.websocket_events[1]).toMatchObject({
      opcode: 2,
      payload_bytes: 0,
      payload_shape: { format: "binary", json_shape: null },
    });
    expect(result.value.completeness.unavailable_sections).toEqual(
      expect.arrayContaining(["json_body_shapes", "websocket_frames"]),
    );
  });
});

const expectSensitiveValuesAbsent = (
  inspection: ReturnType<typeof webPageInspectionSchema.parse>,
  browser: FakeCdpBrowser,
): void => {
  const serialized = JSON.stringify(inspection);
  for (const secret of [
    "page-secret",
    "frame-secret",
    "dom-secret",
    "forbidden",
    "resource-secret",
    "script-secret",
    "inline-secret",
    "map-secret",
    "network-secret",
    "request-secret",
    "request-body-secret",
    "response-secret",
    "response-body-secret",
    "websocket-secret",
    "websocket-url-secret",
    "console-secret",
    "unknown-origin-console-secret",
    "unknown-console-value-secret",
    "storage-secret",
    "cookie-secret",
    "indexed-db-secret",
    "cache-body-secret",
    "secret-id",
    "dom-url-secret",
    "link-secret",
    "csp-secret",
    "hash-secret",
    "header-secret",
  ])
    expect(serialized).not.toContain(secret);
  const methods = browser.commands.map((command) => command.method);
  expect(methods).toContain("Target.detachFromTarget");
  expect(methods).not.toContain("Browser.close");
  expect(methods).not.toContain("Target.closeTarget");
  expect(methods).not.toContain("Runtime.evaluate");
  expect(methods).not.toContain("Network.getResponseBody");
};
