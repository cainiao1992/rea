import { expect, it, onTestFinished, vi } from "vitest";
import { CdpBrowserProvider } from "../../../src/browser/CdpBrowserProvider.js";
import { observeWebSessionInputSchema } from "../../../src/domain/browserSession.js";
import { startFakeCdpBrowser } from "../../fixtures/fakeCdpBrowser.js";

// Scale only the existing retained-event allowance to exercise refusal without
// allocating megabytes. The real HTTP/WebSocket owner and producer parser run.
vi.mock("../../../src/domain/webRuntime.js", async (importOriginal) => {
  const domain =
    await importOriginal<typeof import("../../../src/domain/webRuntime.js")>();
  return {
    ...domain,
    WEB_RUNTIME_LIMITS: {
      ...domain.WEB_RUNTIME_LIMITS,
      retainedEventBytes: 128,
    },
  };
});

it("refuses active document identity retention before reporting a complete session", async () => {
  const browser = await startFakeCdpBrowser({ commandEvents: () => [] });
  const provider = new CdpBrowserProvider();
  onTestFinished(async () => {
    await provider.close();
    await browser.close();
  });
  const result = await provider.observeSession(
    observeWebSessionInputSchema.parse({
      cdp_endpoint: browser.endpoint,
      target_id: "allowed-page",
      allowed_origins: [browser.allowedOrigin],
      observation_ms: 1_000,
    }),
    {
      signal: AbortSignal.timeout(2_000),
      progress: {
        report: async (update) => {
          if (update.completed === 1)
            browser.emitEvent({
              method: "Network.requestWillBeSent",
              sessionId: "session-1",
              params: {
                requestId: "r".repeat(128),
                type: "Document",
                frameId: "frame-main",
                loaderId: "loader",
                timestamp: 100,
                request: {
                  url: `${browser.allowedOrigin}/page`,
                  method: "GET",
                },
              },
            });
        },
      },
    },
  );
  expect(result).toMatchObject({
    ok: false,
    error: {
      _tag: "BrowserObservationError",
      reason: "payload_limit",
      detail: expect.stringContaining("Active document request identities"),
    },
  });
  expect(browser.commands.map(({ method }) => method)).toContain(
    "Target.detachFromTarget",
  );
});
