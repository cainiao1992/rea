import { z } from "zod";
import { jsonObjectSchema, type JsonValue } from "./jsonValue.js";

/** Own every JSON map key, then validate and retain each value's normalized facts. */
export const jsonRecordSchema = <Value extends JsonValue>(
  valueSchema: z.ZodType<Value>,
) => {
  const projection = z.record(z.string(), valueSchema);
  const schema = jsonObjectSchema.transform(
    (value, context): Record<string, Value> => {
      const entries: [string, Value][] = [];
      let invalid = false;
      for (const [key, entry] of Object.entries(value)) {
        const parsed = valueSchema.safeParse(entry);
        if (parsed.success) entries.push([key, parsed.data]);
        else {
          invalid = true;
          for (const issue of parsed.error.issues)
            context.addIssue({ ...issue, path: [key, ...issue.path] });
        }
      }
      return invalid ? z.NEVER : Object.fromEntries(entries);
    },
  );
  // Delegate to Zod's own record projection with the caller's dialect, IO and
  // reference context; a context-free JSON override would lose those choices.
  schema._zod.processJSONSchema = (context, json, params) =>
    projection._zod.processJSONSchema!(context, json, params);
  return schema;
};
