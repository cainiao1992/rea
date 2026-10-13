import canonicalize from "canonicalize";
import { z } from "zod";

import { IDENTIFIER_PATTERN } from "../stringPatterns.js";

import { jsonValueSchema } from "../jsonValue.js";
import {
  comparableProcessObservationPayload,
  processObservationSourceSchema,
} from "./processObservation.js";

const identifierSchema = z.string().regex(IDENTIFIER_PATTERN);

const cardinalitySchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("required") }),
  z.strictObject({ kind: z.literal("optional") }),
  z.strictObject({
    kind: z.literal("exact"),
    count: z.number().int().min(0),
  }),
  z
    .strictObject({
      kind: z.literal("range"),
      min: z.number().int().min(0),
      max: z.number().int().min(0),
    })
    .refine(({ min, max }) => min <= max, {
      message: "cardinality min must not exceed max",
      path: ["min"],
    }),
]);

const eventDeclarationSchema = z.strictObject({
  id: identifierSchema,
  source: processObservationSourceSchema,
  exact: jsonValueSchema,
  ignore_fields: z
    .array(
      z.enum([
        "sequence",
        "at_ms",
        "scheduled_at_ms",
        "dispatched_at_ms",
        "elapsed_ms",
      ]),
    )
    .refine((values) => new Set(values).size === values.length, {
      message: "ignored event fields must be unique",
    })
    .optional(),
  cardinality: cardinalitySchema.default({ kind: "required" }),
});

const partialOrderLanguageSchema = z.strictObject({
  kind: z.literal("partial_order"),
  happens_before: z
    .array(
      z.strictObject({
        before: identifierSchema,
        after: identifierSchema,
      }),
    )
    .default([]),
  not_before: z
    .array(
      z.strictObject({
        event: identifierSchema,
        anchor: identifierSchema,
      }),
    )
    .default([]),
  unordered_groups: z
    .array(z.strictObject({ events: z.array(identifierSchema).min(2) }))
    .default([]),
  prefix: z.array(identifierSchema).default([]),
  suffix: z.array(identifierSchema).default([]),
});

const finiteTraceTokenSchema = z.union([
  identifierSchema,
  z.strictObject({ unordered: z.array(identifierSchema).min(2) }),
]);

const finiteTraceLanguageSchema = z.strictObject({
  kind: z.literal("finite_traces"),
  variants: z
    .array(
      z.strictObject({
        id: identifierSchema,
        trace: z.array(finiteTraceTokenSchema),
      }),
    )
    .min(1),
});

const specificationShapeSchema = z.strictObject({
  events: z.array(eventDeclarationSchema).min(1),
  language: z.discriminatedUnion("kind", [
    partialOrderLanguageSchema,
    finiteTraceLanguageSchema,
  ]),
});

export type ProcessTraceSpecification = z.infer<
  typeof specificationShapeSchema
>;
type PartialOrderLanguage = z.infer<typeof partialOrderLanguageSchema>;
type Reachability = (origin: string) => ReadonlySet<string>;

export const canonicalTraceJson = (value: unknown): string => {
  const serialized = canonicalize(value);
  if (serialized === undefined)
    throw new TypeError("Trace specification contains a non-JSON value");
  return serialized;
};

export const processTraceCardinalityBounds = (
  cardinality: ProcessTraceSpecification["events"][number]["cardinality"],
): readonly [number, number] => {
  switch (cardinality.kind) {
    case "required":
      return [1, 1];
    case "optional":
      return [0, 1];
    case "exact":
      return [cardinality.count, cardinality.count];
    case "range":
      return [cardinality.min, cardinality.max];
  }
};

const addReferenceIssue = (
  context: z.RefinementCtx,
  known: ReadonlySet<string>,
  id: string,
  path: PropertyKey[],
): void => {
  if (!known.has(id))
    context.addIssue({
      code: "custom",
      message: `unknown event id: ${id}`,
      path,
    });
};

const pairKey = (left: string, right: string): string =>
  left <= right ? `${left}\0${right}` : `${right}\0${left}`;

const buildAdjacency = (
  language: PartialOrderLanguage,
  context: z.RefinementCtx,
  known: ReadonlySet<string>,
): ReadonlyMap<string, Set<string>> => {
  const adjacency = new Map([...known].map((id) => [id, new Set<string>()]));
  for (const [index, edge] of language.happens_before.entries()) {
    const path = ["language", "happens_before", index];
    addReferenceIssue(context, known, edge.before, [...path, "before"]);
    addReferenceIssue(context, known, edge.after, [...path, "after"]);
    if (edge.before === edge.after)
      context.addIssue({
        code: "custom",
        message: "happens-before edges must reference distinct events",
        path,
      });
    adjacency.get(edge.before)?.add(edge.after);
  }
  return adjacency;
};

const validateNotBefore = (
  language: PartialOrderLanguage,
  context: z.RefinementCtx,
  known: ReadonlySet<string>,
): ReadonlySet<string> => {
  const pairs = new Set<string>();
  for (const [index, constraint] of language.not_before.entries()) {
    const path = ["language", "not_before", index];
    addReferenceIssue(context, known, constraint.event, [...path, "event"]);
    addReferenceIssue(context, known, constraint.anchor, [...path, "anchor"]);
    if (constraint.event === constraint.anchor)
      context.addIssue({
        code: "custom",
        message: "not-before constraints must reference distinct events",
        path,
      });
    const key = pairKey(constraint.event, constraint.anchor);
    if (pairs.has(key))
      context.addIssue({
        code: "custom",
        message: "not-before event pairs must be declared once",
        path,
      });
    pairs.add(key);
  }
  return pairs;
};

const validateNotBeforeOrder = (
  language: PartialOrderLanguage,
  context: z.RefinementCtx,
  reachable: Reachability,
): void => {
  for (const [index, constraint] of language.not_before.entries())
    if (reachable(constraint.event).has(constraint.anchor))
      context.addIssue({
        code: "custom",
        message: "not-before constraint conflicts with happens-before order",
        path: ["language", "not_before", index],
      });
};

const graphHasCycle = (
  ids: readonly string[],
  adjacency: ReadonlyMap<string, ReadonlySet<string>>,
): boolean => {
  const incoming = new Map(ids.map((id) => [id, 0]));
  for (const successors of adjacency.values())
    for (const successor of successors) {
      const count = incoming.get(successor);
      if (count !== undefined) incoming.set(successor, count + 1);
    }
  const ready = [...incoming].flatMap(([id, count]) =>
    count === 0 ? [id] : [],
  );
  let examined = 0;
  while (ready.length > 0) {
    const current = ready.pop();
    if (current === undefined) break;
    examined++;
    for (const successor of adjacency.get(current) ?? []) {
      const count = incoming.get(successor);
      if (count === undefined) continue;
      incoming.set(successor, count - 1);
      if (count === 1) ready.push(successor);
    }
  }
  return examined !== incoming.size;
};

const createReachability = (
  adjacency: ReadonlyMap<string, ReadonlySet<string>>,
): Reachability => {
  const reachable = new Map<string, Set<string>>();
  return (origin) => {
    const cached = reachable.get(origin);
    if (cached !== undefined) return cached;
    const seen = new Set<string>();
    const pending = [...(adjacency.get(origin) ?? [])];
    while (pending.length > 0) {
      const current = pending.pop();
      if (current === undefined || seen.has(current)) continue;
      seen.add(current);
      for (const successor of adjacency.get(current) ?? [])
        pending.push(successor);
    }
    reachable.set(origin, seen);
    return seen;
  };
};

const isOrdered = (
  reachable: Reachability,
  left: string,
  right: string,
): boolean => reachable(left).has(right) || reachable(right).has(left);

type OrderingRelations = {
  readonly reachable: Reachability;
  readonly notBeforePairs: ReadonlySet<string>;
};

const validateUnorderedGroups = (
  language: PartialOrderLanguage,
  context: z.RefinementCtx,
  known: ReadonlySet<string>,
): ((left: string, right: string) => boolean) => {
  const memberships = new Map<string, Set<number>>();
  for (const [groupIndex, group] of language.unordered_groups.entries()) {
    const path = ["language", "unordered_groups", groupIndex];
    const uniqueIds = new Set(group.events);
    if (uniqueIds.size !== group.events.length)
      context.addIssue({
        code: "custom",
        message: "unordered groups must not repeat event ids",
        path: [...path, "events"],
      });
    for (const [eventIndex, id] of group.events.entries())
      addReferenceIssue(context, known, id, [...path, "events", eventIndex]);
    const overlaps = new Map<number, number>();
    for (const id of uniqueIds) {
      const priorGroups = memberships.get(id) ?? new Set<number>();
      for (const prior of priorGroups)
        overlaps.set(prior, (overlaps.get(prior) ?? 0) + 1);
      priorGroups.add(groupIndex);
      memberships.set(id, priorGroups);
    }
    if ([...overlaps.values()].some((count) => count > 1))
      context.addIssue({
        code: "custom",
        message: "unordered event pairs must be declared once",
        path,
      });
  }
  return (left, right) => {
    const rightGroups = memberships.get(right);
    for (const group of memberships.get(left) ?? [])
      if (rightGroups?.has(group) === true) return true;
    return false;
  };
};

const validateUnorderedOrder = (
  language: PartialOrderLanguage,
  context: z.RefinementCtx,
  relations: OrderingRelations,
): void => {
  for (const [groupIndex, group] of language.unordered_groups.entries())
    for (const [leftIndex, leftId] of group.events.entries()) {
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < group.events.length;
        rightIndex++
      ) {
        const rightId = group.events[rightIndex];
        if (rightId === undefined) continue;
        const key = pairKey(leftId, rightId);
        if (
          isOrdered(relations.reachable, leftId, rightId) ||
          relations.notBeforePairs.has(key)
        )
          context.addIssue({
            code: "custom",
            message: "ordered events cannot also be declared unordered",
            path: ["language", "unordered_groups", groupIndex],
          });
      }
    }
};

const validateCompletePairDeclarations = (
  ids: readonly string[],
  relations: OrderingRelations,
  unorderedPair: (left: string, right: string) => boolean,
  context: z.RefinementCtx,
): void => {
  let missingPairCount = 0;
  let firstMissingPair = "";
  for (const [leftIndex, leftId] of ids.entries()) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < ids.length;
      rightIndex++
    ) {
      const rightId = ids[rightIndex];
      if (rightId === undefined) continue;
      if (isOrdered(relations.reachable, leftId, rightId)) continue;
      const key = pairKey(leftId, rightId);
      if (
        !relations.notBeforePairs.has(key) &&
        !unorderedPair(leftId, rightId)
      ) {
        if (missingPairCount === 0) firstMissingPair = `${leftId}/${rightId}`;
        missingPairCount++;
      }
    }
  }
  if (missingPairCount > 0)
    context.addIssue({
      code: "custom",
      message:
        missingPairCount === 1
          ? `event pair ${firstMissingPair} must be explicitly ordered or unordered`
          : `${String(missingPairCount)} event pairs must be explicitly ordered or unordered; first undeclared pair: ${firstMissingPair}`,
      path: ["language"],
    });
};

const validatePartialOrder = (
  specification: ProcessTraceSpecification,
  context: z.RefinementCtx,
): void => {
  if (specification.language.kind !== "partial_order") return;
  const ids = specification.events.map(({ id }) => id);
  const known = new Set(ids);
  const adjacency = buildAdjacency(specification.language, context, known);
  const cyclic = graphHasCycle(ids, adjacency);
  if (cyclic)
    context.addIssue({
      code: "custom",
      message: "happens-before graph must be acyclic",
      path: ["language"],
    });
  const reachable = createReachability(adjacency);
  const notBeforePairs = validateNotBefore(
    specification.language,
    context,
    known,
  );
  const relations = { reachable, notBeforePairs };
  const unorderedPair = validateUnorderedGroups(
    specification.language,
    context,
    known,
  );
  // Preserve independent declaration diagnostics on cyclic input. Computing
  // all pair relations cannot establish a valid partial order in that case.
  if (!cyclic) {
    validateNotBeforeOrder(specification.language, context, reachable);
    validateUnorderedOrder(specification.language, context, relations);
    validateCompletePairDeclarations(ids, relations, unorderedPair, context);
  }
  for (const [kind, values] of [
    ["prefix", specification.language.prefix],
    ["suffix", specification.language.suffix],
  ] as const)
    for (const [index, id] of values.entries())
      addReferenceIssue(context, known, id, ["language", kind, index]);
};

const countVariantEvents = (
  trace: readonly (string | { readonly unordered: readonly string[] })[],
): ReadonlyMap<string, number> => {
  const counts = new Map<string, number>();
  for (const token of trace)
    for (const id of typeof token === "string" ? [token] : token.unordered)
      counts.set(id, (counts.get(id) ?? 0) + 1);
  return counts;
};

const validateFiniteTraces = (
  specification: ProcessTraceSpecification,
  context: z.RefinementCtx,
): void => {
  if (specification.language.kind !== "finite_traces") return;
  const known = new Set(specification.events.map(({ id }) => id));
  const variantIds = new Set<string>();
  const variantTraces = new Set<string>();
  for (const [
    variantIndex,
    variant,
  ] of specification.language.variants.entries()) {
    const variantPath = ["language", "variants", variantIndex];
    if (variantIds.has(variant.id))
      context.addIssue({
        code: "custom",
        message: "finite trace variant ids must be unique",
        path: [...variantPath, "id"],
      });
    variantIds.add(variant.id);
    const canonicalTrace = canonicalTraceJson(variant.trace);
    if (variantTraces.has(canonicalTrace))
      context.addIssue({
        code: "custom",
        message: "finite trace variants must not duplicate a trace",
        path: [...variantPath, "trace"],
      });
    variantTraces.add(canonicalTrace);
    for (const [tokenIndex, token] of variant.trace.entries()) {
      const values = typeof token === "string" ? [token] : token.unordered;
      for (const [eventIndex, id] of values.entries())
        addReferenceIssue(context, known, id, [
          ...variantPath,
          "trace",
          tokenIndex,
          ...(typeof token === "string" ? [] : ["unordered", eventIndex]),
        ]);
    }
    const counts = countVariantEvents(variant.trace);
    for (const event of specification.events) {
      const [minimum, maximum] = processTraceCardinalityBounds(
        event.cardinality,
      );
      const count = counts.get(event.id) ?? 0;
      if (count < minimum || count > maximum)
        context.addIssue({
          code: "custom",
          message: `variant ${variant.id} violates ${event.id} cardinality`,
          path: [...variantPath, "trace"],
        });
    }
  }
};

/** Strict, bounded concurrency model for Process Capture observations. */
export const processTraceSpecificationSchema =
  specificationShapeSchema.superRefine((specification, context) => {
    const ids = new Set<string>();
    const predicates = new Set<string>();
    const ignoredFieldsBySource = new Map<string, string>();
    for (const [index, event] of specification.events.entries()) {
      if (ids.has(event.id))
        context.addIssue({
          code: "custom",
          message: "event ids must be unique",
          path: ["events", index, "id"],
        });
      ids.add(event.id);
      const ignoredFields = [...(event.ignore_fields ?? [])].sort();
      if (
        ignoredFields.length > 0 &&
        (typeof event.exact !== "object" ||
          event.exact === null ||
          Array.isArray(event.exact))
      )
        context.addIssue({
          code: "custom",
          message: "ignored schedule fields require an exact object payload",
          path: ["events", index, "ignore_fields"],
        });
      const ignoredKey = canonicalTraceJson(ignoredFields);
      const priorIgnoredKey = ignoredFieldsBySource.get(event.source);
      if (priorIgnoredKey !== undefined && priorIgnoredKey !== ignoredKey)
        context.addIssue({
          code: "custom",
          message:
            "events from one source must use the same ignored schedule fields",
          path: ["events", index, "ignore_fields"],
        });
      ignoredFieldsBySource.set(event.source, ignoredKey);
      if (
        ignoredFields.some(
          (field) =>
            typeof event.exact === "object" &&
            event.exact !== null &&
            !Array.isArray(event.exact) &&
            field in event.exact,
        )
      )
        context.addIssue({
          code: "custom",
          message: "exact payload must omit every ignored schedule field",
          path: ["events", index, "exact"],
        });
      const predicate = `${event.source}\0${canonicalTraceJson(
        comparableProcessObservationPayload(event.exact, ignoredFields),
      )}`;
      if (predicates.has(predicate))
        context.addIssue({
          code: "custom",
          message: "exact event predicates must not overlap",
          path: ["events", index],
        });
      predicates.add(predicate);
    }
    validatePartialOrder(specification, context);
    validateFiniteTraces(specification, context);
  });
