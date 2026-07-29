import { expect, it } from "vitest";

import { CdpBrowserProvider } from "../../../src/browser/CdpBrowserProvider.js";
import { inspectWebPageInputSchema } from "../../../src/domain/browserObservation.js";
import { startFakeCdpBrowser } from "../../fixtures/fakeCdpBrowser.js";
import { describeBrowser, trackBrowser } from "./cdpBrowserProvider.support.js";

describeBrowser("CdpBrowserProvider: network 1", () => {
  it("drops network evidence when a request redirects outside the approved origin", async () => {
    const browser = await startFakeCdpBrowser({
      redirectToDisallowedOrigin: true,
    });
    trackBrowser(browser);
    const result = await new CdpBrowserProvider().inspectPage(
      inspectWebPageInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        approved: true,
        observation_ms: 0,
      }),
    );

    if (!result.ok) throw result.error;
    expect(result.value.network.requests).toEqual([]);
  });
});
