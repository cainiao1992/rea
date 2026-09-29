import { z } from "zod";

import {
  applicationCoverageSchema,
  applicationGraphEvidenceSchema,
  applicationNodeIdentitySchema,
} from "./javascriptApplicationEvidenceSchemas.js";
import { isJsonWithinLimits } from "./jsonLimits.js";
import { jsonValueSchema } from "./jsonValue.js";

const boundedTextSchema = z.string().min(1).max(4_096);

/** Node kinds admitted by JavaScript Application Graph. */
export const JAVASCRIPT_APPLICATION_NODE_KINDS = [
  "package",
  "installer",
  "artifact",
  "asar-entry",
  "electron-main",
  "electron-preload",
  "electron-renderer",
  "electron-utility",
  "javascript-asset",
  "javascript-chunk",
  "javascript-module",
  "source-map",
  "source-module",
  "browser-window",
  "frame",
  "target",
  "context-bridge-api",
  "ipc-channel",
  "ipc-handler",
  "worker",
  "service-worker",
  "endpoint",
  "storage",
  "native-addon",
  "native-export",
  "managed-assembly",
  "managed-module",
  "managed-type",
  "managed-method",
  "managed-field",
  "managed-pinvoke-import",
  "managed-native-implementation",
  "runtime-script-instance",
  "unknown",
] as const;

/** Provider-neutral application entity categories. */
const applicationNodeKindSchema = z.enum(JAVASCRIPT_APPLICATION_NODE_KINDS);

/** Directed relations admitted by JavaScript Application Graph. */
export const JAVASCRIPT_APPLICATION_RELATIONS = [
  "contains",
  "loads",
  "imports",
  "maps_to",
  "exposes",
  "sends",
  "invokes",
  "handles",
  "calls",
  "persists_to",
  "observed_as",
  "changed_from",
] as const;

/** Provider-neutral relation categories. */
const applicationRelationSchema = z.enum(JAVASCRIPT_APPLICATION_RELATIONS);

const applicationPropertiesSchema = z
  .record(z.string().min(1).max(128), jsonValueSchema)
  .superRefine((properties, context) => {
    if (Object.keys(properties).length > 64)
      context.addIssue({
        code: "custom",
        message: "Application graph properties exceed 64 keys",
      });
    if (
      !isJsonWithinLimits(properties, {
        maxDepth: 6,
        maxNodes: 512,
        maxStringLength: 4_096,
      })
    )
      context.addIssue({
        code: "custom",
        message: "Application graph properties exceed structural limits",
      });
  });

/** One node observation before its semantic identifier is derived. */
const applicationNodeObservationInputSchema = z.strictObject({
  label: z.string().min(1).max(1_024).nullable(),
  properties: applicationPropertiesSchema,
  evidence: applicationGraphEvidenceSchema,
});

/** One immutable, evidence-bearing observation attached to an entity. */
export const applicationNodeObservationSchema =
  applicationNodeObservationInputSchema.extend({
    observation_id: z.string().regex(/^jag_observation_[a-f0-9]{64}$/u),
    identifier_strategy: z.strictObject({
      strategy: z.literal("semantic-content-sha256"),
      stability: z.literal("observation-exact"),
    }),
  });

/** One application entity before its stable identifier is derived. */
export const applicationNodeInputSchema = z.strictObject({
  kind: applicationNodeKindSchema,
  identity: applicationNodeIdentitySchema,
  observations: z.array(applicationNodeObservationInputSchema).min(1),
});

/** One stable application entity with one or more bounded observations. */
export const applicationNodeSchema = z.strictObject({
  node_id: z.string().regex(/^jag_node_[a-f0-9]{64}$/u),
  kind: applicationNodeKindSchema,
  identity: applicationNodeIdentitySchema,
  observations: z.array(applicationNodeObservationSchema).min(1),
});

/** One directed relationship before its semantic identifier is derived. */
export const applicationEdgeInputSchema = z.strictObject({
  source_node_id: z.string().regex(/^jag_node_[a-f0-9]{64}$/u),
  target_node_id: z.string().regex(/^jag_node_[a-f0-9]{64}$/u),
  relation: applicationRelationSchema,
  properties: applicationPropertiesSchema,
  evidence: applicationGraphEvidenceSchema,
});

/** One directed, evidence-bearing application relationship. */
export const applicationEdgeSchema = applicationEdgeInputSchema.extend({
  edge_id: z.string().regex(/^jag_edge_[a-f0-9]{64}$/u),
  identifier_strategy: z.strictObject({
    strategy: z.literal("semantic-content-sha256"),
    stability: z.literal("relationship-exact"),
  }),
});

/** Graph content before its top-level semantic identifier is derived. */
export const javascriptApplicationGraphInputSchema = z.strictObject({
  schema: z.literal("JavaScriptApplicationGraph"),
  root_node_ids: z.array(z.string().regex(/^jag_node_[a-f0-9]{64}$/u)).min(1),
  nodes: z.array(applicationNodeSchema).min(1),
  edges: z.array(applicationEdgeSchema),
  coverage: applicationCoverageSchema,
  limitations: z.array(boundedTextSchema),
});

/** Strict stored shape for a JavaScript Application Graph. */
export const javascriptApplicationGraphRecordSchema =
  javascriptApplicationGraphInputSchema.extend({
    graph_id: z.string().regex(/^jag_[a-f0-9]{64}$/u),
  });

/** Immutable entity in a JavaScript Application Graph. */
export type ApplicationNode = z.infer<typeof applicationNodeSchema>;
/** Immutable relationship in a JavaScript Application Graph. */
export type ApplicationEdge = z.infer<typeof applicationEdgeSchema>;
/** Complete graph content before its graph identifier is derived. */
export type JavaScriptApplicationGraphInput = z.infer<
  typeof javascriptApplicationGraphInputSchema
>;
