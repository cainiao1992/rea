import { expect, it } from "vitest";

import { CdpBrowserProvider } from "../../../src/browser/CdpBrowserProvider.js";
import { observeWebSessionInputSchema } from "../../../src/domain/browserSession.js";
import { startFakeCdpBrowser } from "../../fixtures/fakeCdpBrowser.js";
import { describeBrowser, trackBrowser } from "./cdpBrowserProvider.support.js";

describeBrowser("CdpBrowserProvider navigation timeline", () => {
  it("accepts caller-selected windows and rejects the removed event-count option", () => {
    const accepted = observeWebSessionInputSchema.safeParse({
      cdp_endpoint: "http://127.0.0.1:9222",
      allowed_origins: ["https://app.example.test"],
      target_id: "page-1",
      observation_ms: 120_000,
    });
    expect(accepted.success).toBe(true);
    expect(
      observeWebSessionInputSchema.safeParse({
        cdp_endpoint: "http://127.0.0.1:9222",
        allowed_origins: ["https://app.example.test"],
        target_id: "page-1",
        max_timeline_events: 1,
      }).success,
    ).toBe(false);
  });

  it("returns every event beyond the former default collection cap", async () => {
    const additionalEvents = 2_001;
    const browser = await startFakeCdpBrowser({
      pageScopedVersionWebSocket: true,
      omitTargetWebSocket: true,
      sessionTimeline: "same_origin",
      sessionTimelineEventCount: additionalEvents,
    });
    trackBrowser(browser);

    const result = await new CdpBrowserProvider().observeSession(
      observeWebSessionInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        observation_ms: 1,
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    expect(result.value.timeline).toHaveLength(additionalEvents + 6);
    expect(result.value.completeness.truncated_sections).not.toContain(
      "timeline",
    );
  });
});
