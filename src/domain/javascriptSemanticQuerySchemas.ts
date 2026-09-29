import { z } from "zod";

import {
  JAVASCRIPT_SEMANTIC_NODE_KINDS,
  JAVASCRIPT_SEMANTIC_RELATIONS,
  javaScriptSemanticNodeSchema,
  javaScriptSemanticRelationSchema,
  javaScriptSemanticUnknownSchema,
} from "./javascriptSemanticGraphSchemas.js";
import { jsonValueSchema } from "./jsonValue.js";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const semanticNodeIdSchema = z.string().regex(/^jsrg_node_[a-f0-9]{64}$/u);

const literalSeedSchema = z.strictObject({
  kind: z.literal("literal"),
  value: jsonValueSchema.refine(
    (value) =>
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean",
    "Literal seeds accept only JSON primitive values",
  ),
});

/** Authenticated starting points accepted by semantic tracing. */
export const javaScriptSemanticQuerySeedSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("semantic-node"),
    node_id: semanticNodeIdSchema,
  }),
  z.strictObject({
    kind: z.literal("application-node"),
    node_id: z.string().regex(/^jag_node_[a-f0-9]{64}$/u),
  }),
  literalSeedSchema,
  z.strictObject({
    kind: z.literal("function"),
    fingerprint_sha256: digestSchema,
  }),
  z.strictObject({
    kind: z.literal("property"),
    name: z.string().min(1).max(4_096),
  }),
  z.strictObject({
    kind: z.literal("endpoint"),
    value: z.string().min(1).max(16_384),
  }),
  z.strictObject({
    kind: z.literal("event"),
    name: z.string().min(1).max(4_096),
  }),
  z.strictObject({
    kind: z.literal("boundary-field"),
    field: z.string().min(1).max(4_096),
  }),
]);

const sourceMapAuthoritySchema = z.strictObject({
  authority: z.literal("none"),
});

/** Parsed pure-domain query over one authenticated companion graph. */
export const javaScriptSemanticQueryInputSchema = z.strictObject({
  seed: javaScriptSemanticQuerySeedSchema,
  direction: z.enum([
    "backward-provenance",
    "forward-influence",
    "callers",
    "ownership",
  ]),
  allowed_relations: z
    .array(z.enum(JAVASCRIPT_SEMANTIC_RELATIONS))
    .min(1)
    .max(JAVASCRIPT_SEMANTIC_RELATIONS.length)
    .optional(),
  include_ambiguous_dynamic_edges: z.boolean().default(false),
  expected: z
    .strictObject({
      role: z.enum(["source", "sink"]),
      classes: z.array(z.enum(JAVASCRIPT_SEMANTIC_NODE_KINDS)).min(1).max(24),
    })
    .nullable()
    .default(null),
  source_map_authority: sourceMapAuthoritySchema.default({ authority: "none" }),
});

/** Deterministic semantic trace result. */
export const javaScriptSemanticQueryResultSchema = z.strictObject({
  query_id: z.string().regex(/^jsrq_[a-f0-9]{64}$/u),
  source_graph_id: z.string().regex(/^jsrg_[a-f0-9]{64}$/u),
  seed: javaScriptSemanticQuerySeedSchema,
  direction: javaScriptSemanticQueryInputSchema.shape.direction,
  status: z.enum(["found", "no-match", "ambiguous", "partial", "unsupported"]),
  seed_node_ids: z.array(semanticNodeIdSchema),
  nodes: z.array(javaScriptSemanticNodeSchema),
  relations: z.array(javaScriptSemanticRelationSchema),
  unknowns: z.array(javaScriptSemanticUnknownSchema),
  expected_match_node_ids: z.array(semanticNodeIdSchema),
  summary: z.strictObject({
    total_seed_matches: z.number().int().min(0),
    traversed_nodes: z.number().int().min(0),
    traversed_relations: z.number().int().min(0),
    traversed_functions: z.number().int().min(0),
    traversed_modules: z.number().int().min(0),
    relevant_unknowns: z.number().int().min(0),
  }),
  coverage: z.strictObject({
    status: z.enum(["complete", "partial", "unavailable"]),
  }),
  limitations: z.array(z.string().min(1).max(4_096)).max(1_000),
});

/** Validated semantic query input. */
export type JavaScriptSemanticQueryInput = z.infer<
  typeof javaScriptSemanticQueryInputSchema
>;
/** Validated semantic query result. */
export type JavaScriptSemanticQueryResult = z.infer<
  typeof javaScriptSemanticQueryResultSchema
>;
