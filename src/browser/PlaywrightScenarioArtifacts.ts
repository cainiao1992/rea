import { createHash } from "node:crypto";

import { z } from "zod";
import type { BrowserContext, Page } from "playwright-core";

import { sanitizeBrowserUrl } from "../domain/browserObservation.js";
import type { BrowserScenario } from "../domain/browserScenario.js";
import {
  browserStepArtifactsSchema,
  type BrowserStepArtifacts,
} from "../domain/browserScenarioCapture.js";
import type { BrowserScenarioSecrets } from "./BrowserScenarioSecrets.js";

const TEXT_ARTIFACT_MAX_BYTES = 1_048_576;

const historyValueSchema = z.strictObject({
  length: z.number().int().min(0),
  navigation_entries: z
    .array(
      z.strictObject({
        type: z.string(),
        name: z.string(),
      }),
    )
    .max(10_000),
});

const storageValueSchema = z.strictObject({
  local_storage: z.array(z.tuple([z.string(), z.string()])).max(10_000),
  session_storage: z.array(z.tuple([z.string(), z.string()])).max(10_000),
});

type SnapshotKind = BrowserScenario["capture"]["after_each_step"][number];

/** Shared retained-count budget for one scenario's screenshot artifacts. */
export class BrowserScenarioCaptureBudget {
  private screenshotCount = 0;
  private metadataBytes = 0;

  constructor(
    private readonly maximumScreenshots: number,
    private readonly maximumMetadataBytes: number,
  ) {}

  claimScreenshot(): boolean {
    if (this.screenshotCount >= this.maximumScreenshots) return false;
    this.screenshotCount += 1;
    return true;
  }

  claimMetadata(bytes: number): boolean {
    if (this.metadataBytes + bytes > this.maximumMetadataBytes) return false;
    this.metadataBytes += bytes;
    return true;
  }
}

const notRequested = () => ({ state: "not_requested" as const });
const missing = (reason: string) => ({ state: "missing" as const, reason });
const truncated = (observed: number, retained: number, reason: string) => ({
  state: "truncated" as const,
  observed,
  retained,
  reason,
});

const textArtifact = (
  text: string,
  maximumBytes: number,
  budget: BrowserScenarioCaptureBudget,
) => {
  const bytes = Buffer.from(text);
  if (bytes.byteLength > maximumBytes)
    return truncated(
      bytes.byteLength,
      0,
      `artifact exceeds ${maximumBytes} bytes`,
    );
  if (!budget.claimMetadata(bytes.byteLength))
    return truncated(
      bytes.byteLength,
      0,
      "scenario metadata byte limit reached",
    );
  return {
    state: "captured" as const,
    value: {
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.byteLength,
      text,
    },
  };
};

const captureScreenshot = async (
  page: Page,
  scenario: BrowserScenario,
  budget: BrowserScenarioCaptureBudget,
) => {
  if (!budget.claimScreenshot())
    return truncated(1, 0, "scenario screenshot count limit reached");
  try {
    const bytes = await page.screenshot({
      type: "png",
      fullPage: false,
      animations: "disabled",
      caret: "hide",
    });
    if (bytes.byteLength > scenario.limits.max_screenshot_bytes)
      return truncated(bytes.byteLength, 0, "screenshot byte limit reached");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    return {
      state: "captured" as const,
      value: {
        uri: `rea://web-screenshot/sha256/${sha256}`,
        sha256,
        bytes: bytes.byteLength,
        media_type: "image/png" as const,
        data_base64: bytes.toString("base64"),
      },
    };
  } catch {
    return missing("screenshot capture failed");
  }
};

const captureDom = async (input: {
  readonly page: Page;
  readonly secrets: BrowserScenarioSecrets;
  readonly maximumBytes: number;
  readonly maximumNodes: number;
  readonly budget: BrowserScenarioCaptureBudget;
}) => {
  const { page, secrets, maximumBytes, maximumNodes, budget } = input;
  try {
    const nodes = await page.locator("*").count();
    if (nodes > maximumNodes)
      return truncated(nodes, 0, "DOM node limit reached");
    return textArtifact(
      secrets.redact(await page.content()),
      Math.min(maximumBytes, TEXT_ARTIFACT_MAX_BYTES),
      budget,
    );
  } catch {
    return missing("DOM capture failed");
  }
};

const captureAccessibility = async (input: {
  readonly page: Page;
  readonly secrets: BrowserScenarioSecrets;
  readonly maximumBytes: number;
  readonly maximumNodes: number;
  readonly budget: BrowserScenarioCaptureBudget;
}) => {
  const { page, secrets, maximumBytes, maximumNodes, budget } = input;
  try {
    const text = await page.locator("html").ariaSnapshot();
    const nodes = text.split("\n").filter((line) => line.trim() !== "").length;
    if (nodes > maximumNodes)
      return truncated(nodes, 0, "accessibility node limit reached");
    return textArtifact(
      secrets.redact(text),
      Math.min(maximumBytes, TEXT_ARTIFACT_MAX_BYTES),
      budget,
    );
  } catch {
    return missing("accessibility capture failed");
  }
};

const navigationType = (
  value: string,
): "navigate" | "reload" | "back_forward" | "prerender" | "unknown" => {
  switch (value) {
    case "navigate":
    case "reload":
    case "back_forward":
    case "prerender":
      return value;
    default:
      return "unknown";
  }
};

const captureHistory = async (
  page: Page,
  budget: BrowserScenarioCaptureBudget,
) => {
  try {
    const raw = historyValueSchema.parse(
      await page.evaluate(`(() => ({
        length: window.history.length,
        navigation_entries: performance.getEntriesByType("navigation").map(
          entry => ({
            type: typeof entry.type === "string" ? entry.type : "unknown",
            name: entry.name
          })
        )
      }))()`),
    );
    if (raw.navigation_entries.length > 256)
      return truncated(
        raw.navigation_entries.length,
        0,
        "navigation history entry limit reached",
      );
    const value = {
      length: raw.length,
      current_url: sanitizeBrowserUrl(page.url()),
      navigation_entries: raw.navigation_entries.map(({ type, name }) => ({
        type: navigationType(type),
        name: sanitizeBrowserUrl(name),
      })),
    };
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (!budget.claimMetadata(bytes))
      return truncated(bytes, 0, "scenario metadata byte limit reached");
    return {
      state: "captured" as const,
      value,
    };
  } catch {
    return missing("history capture failed");
  }
};

const captureStorage = async (input: {
  readonly context: BrowserContext;
  readonly page: Page;
  readonly scenario: BrowserScenario;
  readonly secrets: BrowserScenarioSecrets;
  readonly budget: BrowserScenarioCaptureBudget;
}) => {
  const { context, page, scenario, secrets, budget } = input;
  try {
    const cookies = await context.cookies(scenario.allowed_origins);
    const pageStorage = storageValueSchema.parse(
      await page.evaluate(`(() => ({
        local_storage: Object.entries(window.localStorage),
        session_storage: Object.entries(window.sessionStorage)
      }))()`),
    );
    const observed =
      cookies.length +
      pageStorage.local_storage.length +
      pageStorage.session_storage.length;
    if (observed > scenario.limits.max_storage_entries)
      return truncated(observed, 0, "storage entry limit reached");
    const value = {
      cookies: cookies.map((cookie) => ({
        name: cookie.name,
        domain: cookie.domain,
        path: cookie.path,
        secure: cookie.secure,
        http_only: cookie.httpOnly,
        same_site: cookie.sameSite,
        ...secrets.fingerprint(cookie.value),
      })),
      local_storage: pageStorage.local_storage.map(([name, value]) => ({
        name,
        ...secrets.fingerprint(value),
      })),
      session_storage: pageStorage.session_storage.map(([name, value]) => ({
        name,
        ...secrets.fingerprint(value),
      })),
    };
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (!budget.claimMetadata(bytes))
      return truncated(bytes, 0, "scenario metadata byte limit reached");
    return {
      state: "captured" as const,
      value,
    };
  } catch {
    return missing("storage capture failed");
  }
};

const isAllowedPage = (
  page: Page,
  allowedOrigins: ReadonlySet<string>,
): boolean => {
  try {
    return allowedOrigins.has(new URL(page.url()).origin);
  } catch {
    return false;
  }
};

/** Capture selected step artifacts without retaining data after scope loss. */
export const capturePlaywrightStepArtifacts = async (input: {
  readonly context: BrowserContext;
  readonly page: Page;
  readonly scenario: BrowserScenario;
  readonly secrets: BrowserScenarioSecrets;
  readonly requested: ReadonlySet<SnapshotKind>;
  readonly budget: BrowserScenarioCaptureBudget;
}): Promise<BrowserStepArtifacts> => {
  const { context, page, scenario, secrets, requested, budget } = input;
  const allowed = isAllowedPage(page, new Set(scenario.allowed_origins));
  const denied = () => missing("current page is outside approved origins");
  const state = <Value>(
    kind: SnapshotKind,
    capture: () => Promise<Value>,
  ): Promise<
    Value | ReturnType<typeof notRequested> | ReturnType<typeof missing>
  > =>
    !requested.has(kind)
      ? Promise.resolve(notRequested())
      : allowed || kind === "url"
        ? capture()
        : Promise.resolve(denied());
  return browserStepArtifactsSchema.parse({
    screenshot: await state("screenshot", () =>
      captureScreenshot(page, scenario, budget),
    ),
    dom: await state("dom", () =>
      captureDom({
        page,
        secrets,
        maximumBytes: scenario.limits.max_total_metadata_bytes,
        maximumNodes: scenario.limits.max_dom_nodes,
        budget,
      }),
    ),
    accessibility: await state("accessibility", () =>
      captureAccessibility({
        page,
        secrets,
        maximumBytes: scenario.limits.max_total_metadata_bytes,
        maximumNodes: scenario.limits.max_accessibility_nodes,
        budget,
      }),
    ),
    url: await state("url", async () => {
      const value = sanitizeBrowserUrl(page.url());
      const bytes = Buffer.byteLength(JSON.stringify(value));
      return budget.claimMetadata(bytes)
        ? { state: "captured" as const, value }
        : truncated(bytes, 0, "scenario metadata byte limit reached");
    }),
    history: await state("history", () => captureHistory(page, budget)),
    storage: await state("storage", () =>
      captureStorage({ context, page, scenario, secrets, budget }),
    ),
  });
};
