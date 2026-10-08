import { z } from "zod";

/**
 * Maximum nesting depth accepted for JSON values.
 *
 * Sits well below the point where the recursive `z.json()` core overflows its
 * stack (measured between 2000 and 3000 on Node 24) while leaving room for
 * legitimately deep target-derived trees such as compiled NIB view hierarchies.
 */
export const MAX_JSON_DEPTH = 1000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const exceedsMaxDepth = (root: unknown): boolean => {
  // Depth counts edges from the root.
  const pending: { value: unknown; depth: number }[] = [
    { value: root, depth: 0 },
  ];
  while (pending.length > 0) {
    const item = pending.pop();
    if (item === undefined) break;
    if (item.depth > MAX_JSON_DEPTH) return true;
    const value = item.value;
    if (Array.isArray(value)) {
      for (const child of value)
        pending.push({ value: child, depth: item.depth + 1 });
    } else if (isRecord(value)) {
      for (const key of Object.keys(value))
        pending.push({ value: value[key], depth: item.depth + 1 });
    }
  }
  return false;
};

/**
 * JSON-safe value shared by domain, application, and adapter boundaries.
 *
 * An iterative depth guard runs before the recursive `z.json()` core so
 * hostile nested payloads surface as validation issues instead of RangeErrors.
 * The guard only refuses over-deep values; ordinary JSON parsing semantics
 * (including which members `z.json()` keeps) are unchanged.
 */
const jsonCore = z.json();
// Every JSON value satisfies `{}`. Advertise that instead of Zod's
// self-referential `$defs` projection, which MCP clients and model APIs that
// reject recursive JSON Schemas refuse. Runtime parsing still admits only JSON.
// The override sits on the core as well as on the pipe because the standard
// JSON Schema projection walks into pipe stages without consulting the outer
// node, while the public toJSONSchema projection stops at the pipe.
jsonCore._zod.toJSONSchema = () => ({});
export const jsonValueSchema = z
  .unknown()
  .superRefine((value, context) => {
    if (exceedsMaxDepth(value))
      context.addIssue({
        code: "custom",
        message: `JSON value exceeds maximum nesting depth of ${MAX_JSON_DEPTH}`,
      });
  })
  .pipe(jsonCore);
jsonValueSchema._zod.toJSONSchema = () => ({});

/** JSON object boundary for caller-visible parameter maps. */
export const jsonObjectSchema = z.record(z.string(), jsonValueSchema);

export type JsonValue = z.infer<typeof jsonValueSchema>;
