import { z } from "zod";

import {
  browserAllowedOriginsSchema,
  browserEndpointSchema,
  browserOriginSchema,
} from "./browserObservation.js";

export const BROWSER_SCENARIO_LIMITS = {
  actions: 128,
  secrets: 64,
  storageEntries: 512,
  replayRoutes: 256,
  durationMs: 300_000,
  actionTimeoutMs: 60_000,
} as const;

export const scenarioIdentifierSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9._-]{0,63}$/u);

const absoluteExecutablePathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine(
    (value) =>
      value.startsWith("/") ||
      /^[A-Za-z]:[\\/]/u.test(value) ||
      value.startsWith("\\\\"),
    "Expected an absolute browser executable path",
  );

const browserScenarioBaseUrlSchema = z
  .string()
  .min(1)
  .max(65_536)
  .transform((value, context) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      context.addIssue({ code: "custom", message: "Invalid browser URL" });
      return z.NEVER;
    }
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Browser URLs must be HTTP(S), omit credentials, and declare query values separately",
      });
      return z.NEVER;
    }
    return url.toString();
  });

export const browserScenarioValueSchema = z.discriminatedUnion("source", [
  z.strictObject({
    source: z.literal("literal"),
    value: z.string().max(65_536),
    classification: z.literal("public"),
  }),
  z.strictObject({
    source: z.literal("secret"),
    secret_id: scenarioIdentifierSchema,
  }),
]);
export type BrowserScenarioValue = z.infer<typeof browserScenarioValueSchema>;

const queryEntrySchema = z.strictObject({
  name: z.string().min(1).max(256),
  value: browserScenarioValueSchema,
});

/** URL whose values remain explicit public literals or declared secret references. */
export const browserScenarioUrlSchema = z.strictObject({
  url: browserScenarioBaseUrlSchema,
  query: z.array(queryEntrySchema).max(64).default([]),
});
export type BrowserScenarioUrl = z.infer<typeof browserScenarioUrlSchema>;

export const browserScenarioBrowserSchema = z.discriminatedUnion("mode", [
  z.strictObject({
    mode: z.literal("launch"),
    executable_path: absoluteExecutablePathSchema,
    headless: z.literal(true),
    user_data: z.literal("temporary-owned"),
    cleanup: z.literal("close-and-delete-profile"),
  }),
  z.strictObject({
    mode: z.literal("connect"),
    cdp_endpoint: browserEndpointSchema,
    target_id: z.string().trim().min(1).max(256),
    ownership: z.literal("external"),
    cleanup: z.literal("disconnect-only"),
  }),
]);

export const browserScenarioEnvironmentSchema = z.strictObject({
  viewport: z.strictObject({
    width: z.number().int().min(320).max(7_680),
    height: z.number().int().min(240).max(4_320),
    device_scale_factor: z.number().min(0.5).max(4).default(1),
  }),
  locale: z
    .string()
    .min(2)
    .max(64)
    .regex(/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/u),
  timezone: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+)*$/u),
  color_scheme: z.enum(["light", "dark", "no-preference"]),
  reduced_motion: z.enum(["reduce", "no-preference"]),
  service_workers: z.literal("block"),
});

const locatorSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("test_id"),
    value: z.string().min(1).max(512),
  }),
  z.strictObject({
    kind: z.literal("role"),
    role: z.enum([
      "button",
      "checkbox",
      "combobox",
      "dialog",
      "link",
      "listbox",
      "menuitem",
      "option",
      "radio",
      "slider",
      "spinbutton",
      "switch",
      "tab",
      "textbox",
    ]),
    name: z.string().min(1).max(1_024),
    exact: z.literal(true),
  }),
  z.strictObject({
    kind: z.literal("css"),
    selector: z.string().min(1).max(4_096),
    approved: z.literal(true),
  }),
]);

const stepBase = {
  step_id: scenarioIdentifierSchema,
  timeout_ms: z
    .number()
    .int()
    .min(1)
    .max(BROWSER_SCENARIO_LIMITS.actionTimeoutMs)
    .optional(),
};

export const browserScenarioActionSchema = z.discriminatedUnion("action", [
  z.strictObject({
    ...stepBase,
    action: z.literal("goto"),
    destination: browserScenarioUrlSchema,
    wait_until: z.enum(["commit", "domcontentloaded", "load"]),
  }),
  z.strictObject({
    ...stepBase,
    action: z.literal("click"),
    locator: locatorSchema,
    button: z.enum(["left", "middle", "right"]).default("left"),
    click_count: z.number().int().min(1).max(3).default(1),
  }),
  z.strictObject({
    ...stepBase,
    action: z.literal("fill"),
    locator: locatorSchema,
    value: browserScenarioValueSchema,
  }),
  z.strictObject({
    ...stepBase,
    action: z.literal("press"),
    locator: locatorSchema,
    key: z.string().min(1).max(64),
  }),
  z.strictObject({
    ...stepBase,
    action: z.literal("select_option"),
    locator: locatorSchema,
    value: browserScenarioValueSchema,
  }),
  z.strictObject({
    ...stepBase,
    action: z.enum(["check", "uncheck"]),
    locator: locatorSchema,
  }),
  z.strictObject({
    ...stepBase,
    action: z.literal("wait_for"),
    locator: locatorSchema,
    state: z.enum(["attached", "detached", "visible", "hidden"]),
  }),
  z.strictObject({
    step_id: scenarioIdentifierSchema,
    action: z.literal("wait_for_timeout"),
    duration_ms: z
      .number()
      .int()
      .min(1)
      .max(BROWSER_SCENARIO_LIMITS.actionTimeoutMs),
  }),
]);
export type BrowserScenarioAction = z.infer<typeof browserScenarioActionSchema>;

const storageEntrySchema = z.strictObject({
  name: z.string().min(1).max(1_024),
  value: browserScenarioValueSchema,
});

export const browserScenarioStorageSchema = z.strictObject({
  cookies: z
    .array(
      z.strictObject({
        name: z.string().min(1).max(1_024),
        value: browserScenarioValueSchema,
        destination: browserScenarioUrlSchema,
        http_only: z.boolean(),
        secure: z.boolean(),
        same_site: z.enum(["Strict", "Lax", "None"]),
      }),
    )
    .max(128)
    .default([]),
  local_storage: z
    .array(
      z.strictObject({
        origin: browserOriginSchema,
        entries: z.array(storageEntrySchema).max(128),
      }),
    )
    .max(32)
    .default([]),
  session_storage: z
    .array(
      z.strictObject({
        origin: browserOriginSchema,
        entries: z.array(storageEntrySchema).max(128),
      }),
    )
    .max(32)
    .default([]),
});

const headerNameSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u)
  .transform((value) => value.toLowerCase());

const replayHeaderSchema = z.strictObject({
  name: headerNameSchema,
  value: browserScenarioValueSchema,
});

const replayResponseSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("response"),
    status: z.number().int().min(100).max(599),
    headers: z.array(replayHeaderSchema).max(64).default([]),
    body: browserScenarioValueSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("redirect"),
    status: z.union([
      z.literal(301),
      z.literal(302),
      z.literal(303),
      z.literal(307),
      z.literal(308),
    ]),
    destination: browserScenarioUrlSchema,
  }),
]);

const replayRouteSchema = z.strictObject({
  route_id: scenarioIdentifierSchema,
  method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]),
  request: browserScenarioUrlSchema,
  response: replayResponseSchema,
});

export const browserScenarioRequestReplaySchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("disabled") }),
  z.strictObject({
    mode: z.literal("exact"),
    unmatched: z.enum(["abort", "passthrough-approved-origins"]),
    routes: z
      .array(replayRouteSchema)
      .min(1)
      .max(BROWSER_SCENARIO_LIMITS.replayRoutes),
  }),
]);

export const browserScenarioSecretSchema = z.strictObject({
  secret_id: scenarioIdentifierSchema,
  environment_variable: z.string().regex(/^[A-Z_][A-Z0-9_]{0,127}$/u),
  purpose: z.enum(["input", "storage", "request-replay"]),
  redaction: z.literal("replace-with-secret-reference"),
});

const REQUIRED_REDACTED_HEADERS = [
  "authorization",
  "cookie",
  "proxy-authorization",
  "set-cookie",
] as const;

const normalizedNames = (maximum: number) =>
  z
    .array(
      z
        .string()
        .trim()
        .min(1)
        .max(256)
        .transform((value) => value.toLowerCase()),
    )
    .max(maximum)
    .transform((values) => [...new Set(values)].sort());

export const browserScenarioRedactionSchema = z
  .strictObject({
    secret_values: z.literal("replace-with-secret-reference"),
    query_parameter_names: normalizedNames(128).default([]),
    header_names: normalizedNames(128).default([...REQUIRED_REDACTED_HEADERS]),
  })
  .superRefine(({ header_names: names }, context) => {
    for (const required of REQUIRED_REDACTED_HEADERS)
      if (!names.includes(required))
        context.addIssue({
          code: "custom",
          path: ["header_names"],
          message: `Required credential header ${required} must be redacted`,
        });
  });

const snapshotKindSchema = z.enum([
  "screenshot",
  "dom",
  "accessibility",
  "url",
  "history",
  "storage",
]);

export const browserScenarioCaptureSchema = z.strictObject({
  after_each_step: z.array(snapshotKindSchema).max(6),
  at_end: z.array(snapshotKindSchema).max(6),
  events: z.array(
    z.enum([
      "console",
      "page-errors",
      "network",
      "websockets",
      "frames",
      "workers",
      "popups",
      "downloads",
    ]),
  ),
});

export const browserScenarioCaptureLimitsSchema = z.strictObject({
  max_duration_ms: z
    .number()
    .int()
    .min(100)
    .max(BROWSER_SCENARIO_LIMITS.durationMs),
  action_timeout_ms: z
    .number()
    .int()
    .min(1)
    .max(BROWSER_SCENARIO_LIMITS.actionTimeoutMs),
  navigation_timeout_ms: z
    .number()
    .int()
    .min(1)
    .max(BROWSER_SCENARIO_LIMITS.actionTimeoutMs),
  max_events: z.number().int().min(1).max(100_000),
  max_frames: z.number().int().min(1).max(1_000),
  max_workers: z.number().int().min(0).max(1_000),
  max_popups: z.number().int().min(0).max(100),
  max_websockets: z.number().int().min(0).max(10_000),
  max_dom_nodes: z.number().int().min(1).max(100_000),
  max_accessibility_nodes: z.number().int().min(1).max(100_000),
  max_screenshots: z.number().int().min(0).max(256),
  max_screenshot_bytes: z
    .number()
    .int()
    .min(1)
    .max(8 * 1_024 * 1_024),
  max_storage_entries: z
    .number()
    .int()
    .min(0)
    .max(BROWSER_SCENARIO_LIMITS.storageEntries),
  max_total_metadata_bytes: z
    .number()
    .int()
    .min(1_024)
    .max(64 * 1_024 * 1_024),
});

export const browserScenarioAllowedOriginsSchema = browserAllowedOriginsSchema;
