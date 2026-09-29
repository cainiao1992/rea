import { isAbsolute, resolve } from "node:path";

import { z } from "zod";

import {
  browserEndpointSchema,
  browserOriginSchema,
} from "./browserObservation.js";

const observationTextSchema = z.string().min(1);

const runtimeFileRootsSchema = z
  .array(
    z
      .string()
      .min(1)
      .refine(isAbsolute, "Runtime file roots must be absolute paths")
      .overwrite(resolve),
  )
  .overwrite((roots) => [...new Set(roots)].sort())
  .default([]);

const runtimeOriginsSchema = z
  .array(browserOriginSchema)
  .overwrite((origins) => [...new Set(origins)].sort())
  .default([]);

const runtimeScope = {
  inspector_endpoint: browserEndpointSchema,
  allowed_file_roots: runtimeFileRootsSchema,
  allowed_origins: runtimeOriginsSchema,
};

const requireRuntimeScope = (
  input: {
    readonly allowed_file_roots: readonly string[];
    readonly allowed_origins: readonly string[];
  },
  context: z.RefinementCtx,
): void => {
  if (
    input.allowed_file_roots.length === 0 &&
    input.allowed_origins.length === 0
  )
    context.addIssue({
      code: "custom",
      path: ["allowed_file_roots"],
      message: "At least one exact file root or HTTP(S) origin is required",
    });
};

/** Input for listing approved Node/Electron V8 Inspector targets. */
export const listJavaScriptRuntimeTargetsInputSchema = z
  .strictObject({
    ...runtimeScope,
  })
  .superRefine(requireRuntimeScope);
export type ListJavaScriptRuntimeTargetsInput = z.infer<
  typeof listJavaScriptRuntimeTargetsInputSchema
>;

export const javascriptRuntimeKindSchema = z.enum([
  "node",
  "electron-main",
  "electron-preload",
  "electron-renderer",
]);
const observedJavaScriptRuntimeKindSchema = javascriptRuntimeKindSchema.or(
  z.literal("unknown"),
);

/** Input for one bounded, attach-only V8 Inspector observation. */
export const observeJavaScriptRuntimeToolInputSchema = z.strictObject({
  discovery_evidence_id: z.string().min(1),
  target_id: z.string().trim().min(1),
  runtime_kind: javascriptRuntimeKindSchema.optional(),
  observation_ms: z.number().int().min(0).default(100),
});

/** Input after discovery Evidence supplies the authorized target scope. */
export const observeJavaScriptRuntimeInputSchema = z
  .strictObject({
    ...runtimeScope,
    target_id: z.string().trim().min(1),
    runtime_kind: javascriptRuntimeKindSchema.optional(),
    observation_ms: z.number().int().min(0).default(100),
  })
  .superRefine(requireRuntimeScope);
export type ObserveJavaScriptRuntimeInput = z.infer<
  typeof observeJavaScriptRuntimeInputSchema
>;

export const javascriptRuntimeVersionSchema = z.strictObject({
  product: z.string().min(1),
  protocol_version: z.string().min(1),
  v8_version: z.string().nullable(),
});

export const javascriptRuntimeLocationSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("file"),
    file_path: z.string().min(1),
    authority: z.literal("scope-fallback").optional(),
  }),
  z.strictObject({
    kind: z.literal("url"),
    origin: z.string().min(1),
    sanitized_url: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal("builtin"),
    specifier: z.string().min(1),
  }),
]);
export type JavaScriptRuntimeLocation = z.infer<
  typeof javascriptRuntimeLocationSchema
>;

const javascriptRuntimeTargetSchema = z.strictObject({
  target_id: z.string().min(1),
  protocol_type: z.string().min(1),
  attached: z.boolean(),
  location: javascriptRuntimeLocationSchema,
});

/** Complete root/origin-filtered V8 Inspector target inventory. */
export const javascriptRuntimeTargetListSchema = z.strictObject({
  runtime: javascriptRuntimeVersionSchema,
  targets: z.array(javascriptRuntimeTargetSchema),
  excluded: z.strictObject({
    outside_file_roots: z.number().int().min(0),
    outside_origins: z.number().int().min(0),
    unsupported_location: z.number().int().min(0),
    unconnectable: z.number().int().min(0),
  }),
  limitations: z.array(observationTextSchema),
});
export type JavaScriptRuntimeTargetList = z.infer<
  typeof javascriptRuntimeTargetListSchema
>;

const javascriptRuntimeScriptSchema = z.strictObject({
  script_key: z.string().regex(/^v8_script_[a-f0-9]{64}$/u),
  location: javascriptRuntimeLocationSchema,
  execution_context_key: z.string().nullable(),
  cdp_hash: z.string().nullable(),
  length: z.number().int().min(0),
  is_module: z.boolean(),
  status: z.literal("observed-loaded"),
});

const javascriptRuntimeContextSchema = z.strictObject({
  context_key: z.string().min(1),
  state: z.enum(["created", "destroyed", "cleared"]),
  name: z.string().nullable(),
  origin: z.string().nullable(),
});

/** Deterministic passive script/context snapshot from one bounded window. */
export const javascriptRuntimeObservationSchema = z.strictObject({
  runtime: javascriptRuntimeVersionSchema,
  target: javascriptRuntimeTargetSchema.extend({
    runtime_kind: observedJavaScriptRuntimeKindSchema,
    runtime_kind_authority: z.enum([
      "caller-declared-unverified",
      "not-declared",
    ]),
  }),
  capture: z.strictObject({
    observation_ms: z.number().int().min(0),
    events_observed: z.number().int().min(0),
    events_retained: z.number().int().min(0),
    events_dropped: z.number().int().min(0),
    metadata_bytes_retained: z.number().int().min(0),
    truncated: z.boolean(),
    truncation_reasons: z.array(observationTextSchema),
  }),
  scripts: z.strictObject({
    items: z.array(javascriptRuntimeScriptSchema),
    observed_total: z.number().int().min(0),
    excluded: z.strictObject({
      outside_file_roots: z.number().int().min(0),
      outside_origins: z.number().int().min(0),
      unsupported_location: z.number().int().min(0),
      invalid_protocol_value: z.number().int().min(0),
    }),
  }),
  execution_contexts: z.array(javascriptRuntimeContextSchema),
  directly_observed: z.array(observationTextSchema),
  unavailable_without_instrumentation: z.array(observationTextSchema),
  unknowns: z.array(observationTextSchema),
  limitations: z.array(observationTextSchema),
});
export type JavaScriptRuntimeObservation = z.infer<
  typeof javascriptRuntimeObservationSchema
>;
