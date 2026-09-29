import { z } from "incur";

/** Bound a CLI observation count while preserving its subject-specific help. */
export const boundedCount = (
  subject: string,
  maximum: number,
  fallback: number,
  minimum = 1,
) =>
  z
    .number()
    .int()
    .min(minimum)
    .max(maximum)
    .default(fallback)
    .describe(`Maximum ${subject}`);

/** Bound a CLI observation byte budget. */
export const boundedBytes = (
  subject: string,
  maximum: number,
  fallback: number,
) => boundedCount(`${subject} in bytes`, maximum, fallback);

/** Shared passive browser origin options. */
export const browserScopeOptions = {
  allowedOrigins: z
    .array(z.string().min(1))
    .optional()
    .describe(
      "Exact origins to observe; defaults to REA_BROWSER_ALLOWED_ORIGINS_JSON",
    ),
};

export const browserPageInspectionOptions = z.object({
  ...browserScopeOptions,
  observationMs: boundedCount(
    "observation duration in milliseconds",
    10_000,
    500,
    0,
  ),
  includeAccessibilityText: z
    .boolean()
    .default(false)
    .describe("Include bounded accessibility text"),
  includeConsoleText: z
    .boolean()
    .default(false)
    .describe("Include bounded console message text"),
  includeJsonBodyShapes: z
    .boolean()
    .default(false)
    .describe("Include structural shapes of JSON response bodies"),
  includeWebsocketShapes: z
    .boolean()
    .default(false)
    .describe("Include structural shapes of WebSocket payloads"),
  includeScriptSources: z
    .boolean()
    .default(false)
    .describe("Include bounded JavaScript source text"),
  includeStorageKeys: z
    .boolean()
    .default(false)
    .describe("Include storage key names without values"),
  includeStorageFingerprints: z
    .boolean()
    .default(false)
    .describe("Include content-derived storage fingerprints"),
  maxFrames: boundedCount("page frames", 1_000, 200),
  maxDomNodes: boundedCount("DOM nodes", 10_000, 2_000),
  maxAxNodes: boundedCount("accessibility nodes", 10_000, 2_000),
  maxAxTextFieldBytes: boundedBytes(
    "one accessibility text field",
    16 * 1_024,
    1_024,
  ),
  maxTotalAxTextBytes: boundedBytes(
    "total accessibility text",
    1_024 * 1_024,
    64 * 1_024,
  ),
  maxScripts: boundedCount("scripts", 1_000, 200),
  maxResources: boundedCount("resources", 10_000, 2_000),
  maxWorkers: boundedCount("workers", 5_000, 500),
  maxStorageKeys: boundedCount("storage keys", 10_000, 1_000),
  maxScriptSourceBytes: boundedBytes(
    "one script source",
    4 * 1_024 * 1_024,
    1_024 * 1_024,
  ),
  maxTotalScriptSourceBytes: boundedBytes(
    "total script source",
    16 * 1_024 * 1_024,
    4 * 1_024 * 1_024,
  ),
  maxNetworkEvents: boundedCount("network events", 10_000, 1_000),
  maxConsoleEvents: boundedCount("console events", 2_000, 200),
  maxConsoleTextFieldBytes: boundedBytes(
    "one console text field",
    16 * 1_024,
    1_024,
  ),
  maxTotalConsoleTextBytes: boundedBytes(
    "total console text",
    1_024 * 1_024,
    64 * 1_024,
  ),
  maxJsonBodyBytes: boundedBytes(
    "one JSON response body",
    4 * 1_024 * 1_024,
    1_024 * 1_024,
  ),
  maxTotalJsonBodyBytes: boundedBytes(
    "total JSON response bodies",
    16 * 1_024 * 1_024,
    4 * 1_024 * 1_024,
  ),
  maxJsonShapeNodes: boundedCount("JSON shape nodes", 100_000, 5_000),
  maxJsonShapeDepth: boundedCount("JSON shape depth", 100, 20),
  maxWebsocketEvents: boundedCount("WebSocket events", 5_000, 500),
  maxWebsocketShapeBytes: boundedBytes(
    "one WebSocket shape",
    1_024 * 1_024,
    64 * 1_024,
  ),
  maxTotalWebsocketShapeBytes: boundedBytes(
    "total WebSocket shapes",
    16 * 1_024 * 1_024,
    1_024 * 1_024,
  ),
});

/** Shared passive Electron root options. */
export const electronScopeOptions = {
  allowedFileRoots: z
    .array(z.string().min(1))
    .optional()
    .describe("Filesystem roots; defaults to REA_ELECTRON_FILE_ROOTS_JSON"),
};

export const electronPageInspectionOptions = z.object({
  ...electronScopeOptions,
  observationMs: boundedCount(
    "observation duration in milliseconds",
    10_000,
    100,
    0,
  ),
  includeScriptSources: z
    .boolean()
    .default(false)
    .describe("Include bounded JavaScript source text"),
  maxFrames: boundedCount("page frames", 1_000, 200),
  maxDomNodes: boundedCount("DOM nodes", 10_000, 2_000),
  maxScripts: boundedCount("scripts", 2_000, 500),
  maxResources: boundedCount("resources", 10_000, 2_000),
  maxWorkers: boundedCount("workers", 5_000, 500),
  maxScriptSourceBytes: boundedBytes(
    "one captured script source",
    4 * 1_024 * 1_024,
    1_024 * 1_024,
  ),
  maxTotalScriptSourceBytes: boundedBytes(
    "total captured script source",
    16 * 1_024 * 1_024,
    4 * 1_024 * 1_024,
  ),
});

export const javascriptApplicationOptions = z.object({
  artifactFormat: z
    .enum(["auto", "asar", "directory"])
    .default("auto")
    .describe("Application artifact format"),
});
