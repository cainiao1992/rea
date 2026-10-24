import type { JsonValue } from "../jsonValue.js";
import { isObject, same, type JsonObject } from "./environmentStateRules.js";
import type { FieldRule, WriteCall } from "./environmentStateWriteRules.js";
import { integerOf, readClock } from "./environmentStateWriteValues.js";
import { freshUuid, renewedRule } from "./environmentStateWriteGenerated.js";
import {
  derivedRule,
  freshToken,
  isClockNear,
  nestedClockRule,
  stampRule,
} from "./environmentStateWriteStamps.js";

/** What explaining an update reads: the entity before and after, the call and its method. */
export interface UpdateEvidence {
  readonly before: JsonObject;
  readonly after: JsonObject;
  readonly call: WriteCall & { readonly body: JsonObject };
  readonly method: string;
  readonly idField: string;
  readonly id: string;
  readonly startMs: number | undefined;
  /** Fields covered by a later read view. Missing fields outside that coverage remain unknown. */
  readonly readFields?: readonly string[];
  /** The type's other entities, none of which may hold a value the update generated. */
  readonly others: readonly JsonObject[];
  /** The fields of the observing read's view when that view showed the entity before, so one the entity lacked was added. */
  readonly shown?: readonly string[];
  /** An item action, whose unsent changes take the values it showed. */
  readonly action?: boolean;
}

/** The rule a field the update changed without sending follows, if any; `slugs` maps each echoed member's slug to the first such member. */
export const changeRule = (
  evidence: UpdateEvidence,
  field: string,
  slugs: ReadonlyMap<string, string>,
): FieldRule | undefined => {
  const before = evidence.before[field];
  const after = evidence.after[field]!;
  if (readClock(after) !== undefined && isClockNear(after, evidence.startMs))
    return { field, rule: "clock", format: readClock(after)!.format };
  if (freshUuid(evidence, field)) return { field, rule: "unique" };
  // A renamed slug is spelled like a token, so the slug comes first.
  const member = typeof after === "string" ? slugs.get(after) : undefined;
  if (member !== undefined) return { field, rule: "slug", from: member };
  if (freshToken(evidence, field)) return { field, rule: "unique" };
  const nested = nestedClockRule(field, { before, after }, evidence);
  if (nested !== undefined) return nested;
  // Child rows only: a single UUID that changed is a reference or a generated value, judged above.
  const renewed =
    Array.isArray(before) || isObject(before)
      ? renewedRule(field, { before, after }, evidence.others)
      : undefined;
  if (renewed !== undefined) return renewed;
  const was = integerOf(before);
  if (was !== undefined && integerOf(after) === was + 1)
    return { field, rule: "increment" };
  return (
    stampRule(evidence, field) ??
    derivedRule(evidence, field) ??
    actionRule(evidence, field)
  );
};

/** An item action sets a scalar it names; a changed object, list or instant is another write's doing or a regenerated value. */
const actionRule = (
  evidence: UpdateEvidence,
  field: string,
): FieldRule | undefined => {
  const after = evidence.after[field]!;
  return evidence.action === true &&
    (after === null || typeof after !== "object") &&
    readClock(after) === undefined
    ? { field, rule: "set", value: after }
    : undefined;
};

/** Whether a clock stored in whole seconds names the second a call started in, where a fresh stamp would read the same. */
const inCallSecond = (
  value: JsonValue | undefined,
  startMs: number | undefined,
): boolean => {
  const clock = readClock(value);
  return (
    clock !== undefined &&
    startMs !== undefined &&
    clock.ms % 1000 === 0 &&
    clock.subMillisecond === 0 &&
    Math.abs(clock.ms - startMs) < 1000
  );
};

/** A sent clock the call left as it was, stored in whole seconds and naming the second the call ran in: the application stamps it anew, and the client sent back the one it read. */
export const heldClock = (
  evidence: UpdateEvidence,
  member: string,
  sent: JsonValue,
): boolean =>
  inCallSecond(sent, evidence.startMs) &&
  same(evidence.before[member], sent) &&
  same(evidence.after[member], sent);

/** A field naming when its entity was made (`createdAt`, `row_created_timestamp`), which no update stamps. */
const CREATION_CLOCK = /creat(?:ed|ion)/iu;

/** Unsent clocks an update left as they were in the second it ran, other than creation clocks: a fresh stamp would read the same, so the call cannot show whether it stamps them. */
export const sameSecondClocks = (evidence: UpdateEvidence): string[] =>
  Object.keys(evidence.after).filter(
    (field) =>
      !CREATION_CLOCK.test(field) &&
      !Object.hasOwn(evidence.call.body, field) &&
      Object.hasOwn(evidence.before, field) &&
      same(evidence.before[field], evidence.after[field]) &&
      inCallSecond(evidence.after[field], evidence.startMs),
  );

/** How an update stored a sent member: stamped anew as the one held clock it sent back other than a creation clock, echoed, renewed as a fresh UUID, or as a constant. */
export const sentRule = (
  evidence: UpdateEvidence,
  member: string,
  held: readonly string[],
): FieldRule => {
  const sent = evidence.call.body[member]!;
  if (held.length === 1 && held[0] === member && !CREATION_CLOCK.test(member))
    return {
      field: member,
      rule: "held-clock",
      format: readClock(sent)!.format,
    };
  if (same(evidence.after[member], sent))
    return { field: member, rule: "echo" };
  return freshUuid(evidence, member)
    ? { field: member, rule: "unique" }
    : { field: member, rule: "constant", value: evidence.after[member]! };
};
