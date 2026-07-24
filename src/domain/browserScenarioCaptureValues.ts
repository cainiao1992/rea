import { createHash } from "node:crypto";

import { z } from "zod";

import { sanitizedBrowserUrlSchema } from "./browserObservation.js";
import { webScreenshotArtifactSchema } from "./webScreenshot.js";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const boundedTextSchema = z.string().max(1_048_576);

const textArtifactSchema = z
  .strictObject({
    sha256: digestSchema,
    bytes: z
      .number()
      .int()
      .min(0)
      .max(16 * 1_024 * 1_024),
    text: boundedTextSchema,
  })
  .superRefine((artifact, context) => {
    const bytes = Buffer.from(artifact.text);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (bytes.byteLength !== artifact.bytes || sha256 !== artifact.sha256)
      context.addIssue({
        code: "custom",
        message: "Text artifact digest or size mismatch",
      });
  });

export const captureStateSchema = <Schema extends z.ZodType>(value: Schema) =>
  z.discriminatedUnion("state", [
    z.strictObject({ state: z.literal("captured"), value }),
    z.strictObject({
      state: z.literal("not_requested"),
    }),
    z.strictObject({
      state: z.literal("missing"),
      reason: z.string().min(1).max(1_024),
    }),
    z.strictObject({
      state: z.literal("truncated"),
      observed: z.number().int().min(0),
      retained: z.number().int().min(0),
      reason: z.string().min(1).max(1_024),
    }),
  ]);

const historySchema = z.strictObject({
  length: z.number().int().min(0),
  current_url: sanitizedBrowserUrlSchema,
  navigation_entries: z
    .array(
      z.strictObject({
        type: z.enum([
          "navigate",
          "reload",
          "back_forward",
          "prerender",
          "unknown",
        ]),
        name: sanitizedBrowserUrlSchema,
      }),
    )
    .max(256),
});

const storageValueSchema = z.strictObject({
  name: z.string().max(1_024),
  value_state: z.enum(["hashed", "redacted-secret"]),
  value_sha256: digestSchema.nullable(),
});

const storageSnapshotSchema = z.strictObject({
  cookies: z
    .array(
      z.strictObject({
        name: z.string().max(1_024),
        domain: z.string().max(2_048),
        path: z.string().max(4_096),
        secure: z.boolean(),
        http_only: z.boolean(),
        same_site: z.enum(["Strict", "Lax", "None"]),
        value_state: z.enum(["hashed", "redacted-secret"]),
        value_sha256: digestSchema.nullable(),
      }),
    )
    .max(512),
  local_storage: z.array(storageValueSchema).max(512),
  session_storage: z.array(storageValueSchema).max(512),
});

export const browserStepArtifactsSchema = z.strictObject({
  screenshot: captureStateSchema(webScreenshotArtifactSchema),
  dom: captureStateSchema(textArtifactSchema),
  accessibility: captureStateSchema(textArtifactSchema),
  url: captureStateSchema(sanitizedBrowserUrlSchema),
  history: captureStateSchema(historySchema),
  storage: captureStateSchema(storageSnapshotSchema),
});
export type BrowserStepArtifacts = z.infer<typeof browserStepArtifactsSchema>;

const eventBase = {
  sequence: z.number().int().min(1),
  step_index: z.number().int().min(0),
};

const eventUrl = sanitizedBrowserUrlSchema.nullable();

export const browserScenarioEventSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...eventBase,
    kind: z.literal("console"),
    level: z.string().min(1).max(64),
    text: z.string().max(65_536),
    url: eventUrl,
  }),
  z.strictObject({
    ...eventBase,
    kind: z.literal("page-error"),
    message: z.string().max(65_536),
    stack: z.string().max(262_144).nullable(),
  }),
  z.strictObject({
    ...eventBase,
    kind: z.enum(["request", "response", "request-failed"]),
    method: z.string().min(1).max(32),
    url: sanitizedBrowserUrlSchema,
    resource_type: z.string().min(1).max(64),
    status: z.number().int().min(100).max(599).nullable(),
    header_names: z.array(z.string().max(256)).max(256),
    failure: z.string().max(1_024).nullable(),
  }),
  z.strictObject({
    ...eventBase,
    kind: z.enum(["websocket-opened", "websocket-closed"]),
    url: sanitizedBrowserUrlSchema,
  }),
  z.strictObject({
    ...eventBase,
    kind: z.enum(["websocket-frame-sent", "websocket-frame-received"]),
    url: sanitizedBrowserUrlSchema,
    payload_type: z.enum(["text", "binary"]),
    payload_bytes: z.number().int().min(0),
    payload_text: z.string().max(65_536).nullable(),
    truncated: z.boolean(),
  }),
  z.strictObject({
    ...eventBase,
    kind: z.enum([
      "frame-attached",
      "frame-detached",
      "frame-navigated",
      "worker-created",
      "worker-closed",
      "popup-opened",
      "popup-closed",
    ]),
    url: eventUrl,
    name: z.string().max(1_024).nullable(),
  }),
  z.strictObject({
    ...eventBase,
    kind: z.literal("download-cancelled"),
    suggested_filename: z.string().max(1_024),
    url: sanitizedBrowserUrlSchema,
  }),
]);
export type BrowserScenarioEvent = z.infer<typeof browserScenarioEventSchema>;

const completenessSectionSchema = z.enum([
  "action",
  "screenshot",
  "dom",
  "accessibility",
  "url",
  "history",
  "storage",
  "events",
  "frames",
  "workers",
  "popups",
  "websockets",
]);

export const browserScenarioCompletenessSchema = z
  .strictObject({
    status: z.enum(["complete", "incomplete", "truncated"]),
    equality_eligible: z.boolean(),
    missing_sections: z.array(completenessSectionSchema),
    truncated_sections: z.array(completenessSectionSchema),
  })
  .superRefine((value, context) => {
    const expectedStatus =
      value.truncated_sections.length > 0
        ? "truncated"
        : value.missing_sections.length > 0
          ? "incomplete"
          : "complete";
    if (value.status !== expectedStatus)
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Completeness status does not match section accounting",
      });
    if (value.equality_eligible !== (expectedStatus === "complete"))
      context.addIssue({
        code: "custom",
        path: ["equality_eligible"],
        message: "Missing or truncated evidence is never equality-eligible",
      });
  });
export type BrowserScenarioCompleteness = z.infer<
  typeof browserScenarioCompletenessSchema
>;

export const browserScenarioStepSchema = z.strictObject({
  step_index: z.number().int().min(0),
  step_id: z.string().min(1).max(64),
  action: z.string().min(1).max(64),
  status: z.enum(["completed", "failed", "cancelled"]),
  elapsed_ms: z.number().int().min(0),
  before_url: sanitizedBrowserUrlSchema,
  after_url: sanitizedBrowserUrlSchema,
  error: z.string().max(4_096).nullable(),
  event_sequence_start: z.number().int().min(1),
  event_sequence_end: z.number().int().min(0),
  artifacts: browserStepArtifactsSchema,
  completeness: browserScenarioCompletenessSchema,
});
export type BrowserScenarioStep = z.infer<typeof browserScenarioStepSchema>;
