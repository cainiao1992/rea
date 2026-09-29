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

/** Accept an agent-selected browser observation duration without an artificial ceiling. */
export const observationDuration = (fallback: number, minimum = 0) =>
  z
    .number()
    .int()
    .min(minimum)
    .default(fallback)
    .describe("Observation duration in milliseconds");

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
  observationMs: observationDuration(500),
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
});

export const javascriptApplicationOptions = z.object({
  artifactFormat: z
    .enum(["auto", "asar", "directory"])
    .default("auto")
    .describe("Application artifact format"),
});
