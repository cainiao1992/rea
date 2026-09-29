import { z } from "zod";

import {
  browserAllowedOriginsSchema,
  browserEndpointSchema,
  browserOriginSchema,
} from "./browserObservation.js";

export const scenarioIdentifierSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9._-]*$/u);

const absoluteExecutablePathSchema = z
  .string()
  .min(1)
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
    value: z.string(),
    classification: z.literal("public"),
  }),
  z.strictObject({
    source: z.literal("secret"),
    secret_id: scenarioIdentifierSchema,
  }),
]);
export type BrowserScenarioValue = z.infer<typeof browserScenarioValueSchema>;

const queryEntrySchema = z.strictObject({
  name: z.string().min(1),
  value: browserScenarioValueSchema,
});

/** URL whose values remain explicit public literals or declared secret references. */
export const browserScenarioUrlSchema = z.strictObject({
  url: browserScenarioBaseUrlSchema,
  query: z.array(queryEntrySchema).default([]),
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
    target_id: z.string().trim().min(1),
    ownership: z.literal("external"),
    cleanup: z.literal("disconnect-only"),
  }),
]);

export const browserScenarioEnvironmentSchema = z
  .strictObject({
    viewport: z
      .strictObject({
        width: z.number().int().min(320).max(7_680).default(1_280),
        height: z.number().int().min(240).max(4_320).default(720),
        device_scale_factor: z.number().min(0.5).max(4).default(1),
      })
      .default({ width: 1_280, height: 720, device_scale_factor: 1 }),
    locale: z
      .string()
      .min(2)
      .regex(/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/u)
      .default("en-US"),
    timezone: z
      .string()
      .min(1)
      .regex(/^[A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+)*$/u)
      .default("UTC"),
    color_scheme: z.enum(["light", "dark", "no-preference"]).default("light"),
    reduced_motion: z.enum(["reduce", "no-preference"]).default("reduce"),
    service_workers: z.literal("block").default("block"),
  })
  .default({
    viewport: { width: 1_280, height: 720, device_scale_factor: 1 },
    locale: "en-US",
    timezone: "UTC",
    color_scheme: "light",
    reduced_motion: "reduce",
    service_workers: "block",
  })
  .describe(
    "Optional deterministic browser settings. Defaults to 1280x720, en-US, UTC, light mode, reduced motion, and blocked service workers.",
  );

const locatorSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("test_id"),
    value: z.string().min(1),
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
    name: z.string().min(1),
    exact: z.literal(true),
  }),
  z.strictObject({
    kind: z.literal("css"),
    selector: z.string().min(1),
  }),
]);

const stepBase = {
  step_id: scenarioIdentifierSchema,
  timeout_ms: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      "Optional action deadline in milliseconds; omitted means wait until completion or request cancellation.",
    ),
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
    key: z.string().min(1),
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
      .describe(
        "Wait this many milliseconds; the wait ends early on cancellation.",
      ),
  }),
]);
export type BrowserScenarioAction = z.infer<typeof browserScenarioActionSchema>;

const storageEntrySchema = z.strictObject({
  name: z.string().min(1),
  value: browserScenarioValueSchema,
});

export const browserScenarioStorageSchema = z
  .strictObject({
    cookies: z
      .array(
        z.strictObject({
          name: z.string().min(1),
          value: browserScenarioValueSchema,
          destination: browserScenarioUrlSchema,
          http_only: z.boolean(),
          secure: z.boolean(),
          same_site: z.enum(["Strict", "Lax", "None"]),
        }),
      )
      .default([]),
    local_storage: z
      .array(
        z.strictObject({
          origin: browserOriginSchema,
          entries: z.array(storageEntrySchema),
        }),
      )
      .default([]),
    session_storage: z
      .array(
        z.strictObject({
          origin: browserOriginSchema,
          entries: z.array(storageEntrySchema),
        }),
      )
      .default([]),
  })
  .default({ cookies: [], local_storage: [], session_storage: [] })
  .describe(
    "Optional initial cookies, local storage, or session storage. Defaults to empty; every supplied value and origin must be explicitly declared and approved.",
  );

const headerNameSchema = z
  .string()
  .min(1)
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
    headers: z.array(replayHeaderSchema).default([]),
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

export const browserScenarioRequestReplaySchema = z
  .discriminatedUnion("mode", [
    z.strictObject({ mode: z.literal("disabled") }),
    z.strictObject({
      mode: z.literal("exact"),
      unmatched: z.enum(["abort", "passthrough-approved-origins"]),
      routes: z.array(replayRouteSchema).min(1),
    }),
  ])
  .default({ mode: "disabled" })
  .describe(
    "Optional exact request replay. Defaults to disabled; replay routes and unmatched-request behavior must be explicitly declared when enabled.",
  );

export const browserScenarioSecretSchema = z.strictObject({
  secret_id: scenarioIdentifierSchema,
  environment_variable: z.string().regex(/^[A-Z_][A-Z0-9_]*$/u),
  purpose: z.enum(["input", "storage", "request-replay"]),
  redaction: z.literal("replace-with-secret-reference"),
});

const REQUIRED_REDACTED_HEADERS = [
  "authorization",
  "cookie",
  "proxy-authorization",
  "set-cookie",
] as const;

const normalizedNames = () =>
  z
    .array(
      z
        .string()
        .trim()
        .min(1)
        .transform((value) => value.toLowerCase()),
    )
    .transform((values) => [...new Set(values)].sort());

export const browserScenarioRedactionSchema = z
  .strictObject({
    secret_values: z
      .literal("replace-with-secret-reference")
      .default("replace-with-secret-reference"),
    query_parameter_names: normalizedNames().default([]),
    header_names: normalizedNames().default([...REQUIRED_REDACTED_HEADERS]),
  })
  .superRefine(({ header_names: names }, context) => {
    for (const required of REQUIRED_REDACTED_HEADERS)
      if (!names.includes(required))
        context.addIssue({
          code: "custom",
          path: ["header_names"],
          message: `Required credential header ${required} must be redacted`,
        });
  })
  .default({
    secret_values: "replace-with-secret-reference",
    query_parameter_names: [],
    header_names: [...REQUIRED_REDACTED_HEADERS],
  })
  .describe(
    "Redaction policy. Secret values and credential headers are always redacted; list query parameter names when a secret is used in a URL.",
  );

const snapshotKindSchema = z.enum([
  "screenshot",
  "dom",
  "accessibility",
  "url",
  "history",
  "storage",
]);

export const browserScenarioCaptureSchema = z
  .strictObject({
    after_each_step: z.array(snapshotKindSchema).max(6).default([]),
    at_end: z.array(snapshotKindSchema).max(6).default(["url"]),
    events: z
      .array(
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
      )
      .default([]),
  })
  .default({ after_each_step: [], at_end: ["url"], events: [] })
  .describe(
    "Optional retained artifacts and event families. Defaults to only a final sanitized URL; request screenshots, DOM, accessibility, history, storage, and event capture explicitly.",
  );

export const browserScenarioAllowedOriginsSchema = browserAllowedOriginsSchema;
