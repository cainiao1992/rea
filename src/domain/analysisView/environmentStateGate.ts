import { canonicalJson } from "../comparisonSemantics.js";
import type { JsonValue } from "../jsonValue.js";
import { compareUnicodeCodePoints as compare } from "../unicodeCodePointOrder.js";
import {
  at,
  collectionPathOf,
  isObject,
  lastSegmentValue,
  listItems,
  renderStateEntity,
  renderStateList,
  replaceAt,
  same,
  scalarText,
  type JsonObject,
  type RecordedViewReason,
  type StateEntity,
  type StateRecordFacts,
  type StateToolFacts,
  type StateView,
} from "./environmentStateRules.js";
import { startsAtBeginning } from "./environmentStatePaging.js";
import { ENTRY_BYTES, textBytes } from "./webNetworkRouteTemplates.js";

/** A read tool whose recordings locate entities of one type at one pointer. */
export interface StatePlan {
  readonly tool: StateToolFacts;
  readonly item: boolean;
  readonly type: string;
  readonly pointer: string;
  /** Successful init recordings in timeline order. */
  readonly recordings: readonly StateRecordFacts[];
  /** The latest of them per request line, in timeline order. */
  readonly latest: readonly StateRecordFacts[];
}

/** What the gate reads from an extraction; `withBody` drops each body's temporary work after `use`. */
export interface StateGateContext {
  readonly withBody: <T>(
    ordinal: number,
    use: (body: JsonValue | undefined) => T,
  ) => T;
  readonly retain: (bytes: number) => void;
  readonly entity: (
    type: string,
    collection: string,
    id: string,
  ) => StateEntity | undefined;
  readonly inCollection: (type: string, collection: string) => StateEntity[];
  readonly volatileOf: (type: string) => ReadonlySet<string>;
  readonly idField: (type: string) => string;
}

/** Ordered key union and always-present keys, grown one object at a time. */
class FieldUnion {
  readonly fields: string[] = [];
  /** Membership beside the ordered list, so a wide object is not scanned per key. */
  readonly #seen = new Set<string>();
  #required: Set<string> | undefined;

  add(object: JsonObject): void {
    for (const key of Object.keys(object))
      if (!this.#seen.has(key)) {
        this.#seen.add(key);
        this.fields.push(key);
      }
    const keys = new Set(Object.keys(object));
    this.#required =
      this.#required === undefined
        ? keys
        : new Set([...this.#required].filter((key) => keys.has(key)));
  }

  get required(): string[] {
    return this.fields.filter((key) => this.#required?.has(key) === true);
  }

  /** Retained bytes of the field lists a plan keeps. */
  get bytes(): number {
    return this.fields.reduce(
      (sum, name) => sum + ENTRY_BYTES * 2 + textBytes(name.length) * 2,
      ENTRY_BYTES * 2,
    );
  }
}

const recorded = (plan: StatePlan, reason: RecordedViewReason): StateView => ({
  tool: plan.tool.name,
  shape: "recorded",
  reason,
});

/** Why one latest item recording does not render from the shared envelope and the entity's state, if it does not. */
const itemMismatch = (
  context: StateGateContext,
  plan: StatePlan,
  check: {
    readonly view: { readonly tool: string; readonly fields: string[] };
    readonly envelope: { skeleton?: string };
  },
  record: StateRecordFacts,
): RecordedViewReason | undefined => {
  const { view, envelope } = check;
  const entity = context.entity(
    plan.type,
    collectionPathOf(record, true),
    lastSegmentValue(record.path),
  );
  return context.withBody(record.ordinal, (body) => {
    const object = body === undefined ? undefined : at(body, plan.pointer);
    if (entity === undefined || body === undefined || !isObject(object))
      return "fields-differ";
    const skeleton = canonicalJson(
      replaceAt(body, plan.pointer, null),
      "Environment state",
    );
    if (envelope.skeleton === undefined) {
      context.retain(textBytes(skeleton.length));
      envelope.skeleton = skeleton;
    }
    if (skeleton !== envelope.skeleton) return "envelope-varies";
    const shown = renderStateEntity(
      entity,
      view,
      context.volatileOf(plan.type),
      object,
    );
    return same(shown, object) ? undefined : "fields-differ";
  });
};

/** An item plan must reproduce each latest recording from the first one's envelope and the entity's state. */
export const checkItemPlan = (
  context: StateGateContext,
  plan: StatePlan,
): StateView => {
  const union = new FieldUnion();
  for (const record of plan.latest)
    context.withBody(record.ordinal, (body) => {
      const object = body === undefined ? undefined : at(body, plan.pointer);
      if (isObject(object)) union.add(object);
    });
  context.retain(union.bytes);
  const view = { tool: plan.tool.name, fields: union.fields };
  const envelope: { skeleton?: string } = {};
  for (const record of plan.latest) {
    const reason = itemMismatch(context, plan, { view, envelope }, record);
    if (reason !== undefined) return recorded(plan, reason);
  }
  return {
    tool: plan.tool.name,
    shape: "item",
    type: plan.type,
    pointer: plan.pointer,
    fields: union.fields,
    required_fields: union.required,
    envelope_ordinal: plan.latest[0]!.ordinal,
    checked_record_ordinals: plan.latest.map((record) => record.ordinal),
  };
};

/** The latest recordings that list their whole collection in state order, and the counters that equal the item count on each of them, or on every line when none does. */
const listFacts = (
  context: StateGateContext,
  plan: StatePlan,
  union: FieldUnion,
): { readonly whole: ReadonlySet<number>; readonly counters: string[] } => {
  const field = context.idField(plan.type);
  const whole = new Set<number>();
  const counting = new Map<number, string[]>();
  for (const record of plan.latest)
    context.withBody(record.ordinal, (body) => {
      const items =
        body === undefined ? undefined : listItems(body, plan.pointer);
      if (body === undefined || items === undefined) return;
      items.forEach((item) => union.add(item));
      const parent = plan.pointer === "" || !isObject(body) ? {} : body;
      const counted = Object.keys(parent).filter(
        (name) => isItemTotal(name) && countOf(parent[name]) !== undefined,
      );
      counting.set(
        record.ordinal,
        counted.filter((name) => parent[name] === items.length),
      );
      // A later (or ambiguously positioned) page cannot establish whole membership,
      // even when its collection is empty. Totals and continuation also disprove it.
      if (
        !startsAtBeginning(record.query) ||
        counted.some((name) => countOf(parent[name]) !== items.length) ||
        Object.keys(parent).some((name) => continues(name, parent[name]))
      )
        return;
      const ids = items.map((item) => scalarText(item[field]) ?? "");
      const expected = context
        .inCollection(plan.type, collectionPathOf(record, false))
        .map((entity) => entity.id);
      if (same(ids, expected)) whole.add(record.ordinal);
    });
  // A whole line's counters count the collection, which a partial page's total does not, so the whole lines decide.
  const lines = [...counting].filter(
    ([ordinal]) => whole.size === 0 || whole.has(ordinal),
  );
  const counters = lines.reduce<string[] | undefined>(
    (kept, [, names]) =>
      kept === undefined ? names : kept.filter((name) => names.includes(name)),
    undefined,
  );
  return { whole, counters: (counters ?? []).sort(compare) };
};

const nameTokens = (name: string): string[] =>
  name
    .split(/[_\-\s]|(?<=[a-z0-9])(?=[A-Z])/u)
    .map((token) => token.toLowerCase());

const LISTED_NOUNS = new Set(["elements", "entries", "items", "results"]);

/** Item totals, including compact `totalcount`/`itemcount` and `numberOfElements`; page counts and account IDs are excluded. */
const isItemTotal = (name: string): boolean => {
  const tokens = nameTokens(name);
  return (
    (tokens.some(
      (token) =>
        token === "total" ||
        token === "count" ||
        token === "totalcount" ||
        token === "itemcount",
    ) ||
      (tokens.includes("number") &&
        tokens.some((token) => LISTED_NOUNS.has(token)))) &&
    !tokens.some(
      (token) => token === "page" || token === "pages" || token === "per",
    )
  );
};

/** A count recorded as a number or as a string of digits. */
const countOf = (value: JsonValue | undefined): number | undefined =>
  typeof value === "number"
    ? value
    : typeof value === "string" && /^\d+$/u.test(value)
      ? Number(value)
      : undefined;

const CONTINUATION_NAMES = new Set([
  "hasmore",
  "next",
  "nextcursor",
  "nextpage",
  "nextpagetoken",
  "nexttoken",
]);

/** A top-level `has_more`, `next` or next-page token member that says more items follow. */
const continues = (name: string, value: JsonValue | undefined): boolean =>
  CONTINUATION_NAMES.has(nameTokens(name).join("")) &&
  value !== undefined &&
  value !== null &&
  value !== false &&
  value !== "";

/** Whether one latest list recording renders from its own envelope and the listed entities' state. */
const listReproduces = (
  context: StateGateContext,
  plan: StatePlan,
  view: {
    readonly tool: string;
    readonly fields: string[];
    readonly pointer: string;
    readonly counters: string[];
    readonly whole: ReadonlySet<number>;
  },
  record: StateRecordFacts,
): boolean => {
  const field = context.idField(plan.type);
  return context.withBody(record.ordinal, (body) => {
    const items =
      body === undefined ? undefined : listItems(body, plan.pointer);
    if (body === undefined || items === undefined) return false;
    const observed = new Map(
      items.map((item) => [scalarText(item[field]) ?? "", item]),
    );
    const members = view.whole.has(record.ordinal)
      ? context.inCollection(plan.type, collectionPathOf(record, false))
      : items.flatMap((item) => {
          const entity = context.entity(
            plan.type,
            collectionPathOf(record, false),
            scalarText(item[field]) ?? "",
          );
          return entity === undefined ? [] : [entity];
        });
    const rendered = members.map((entity) =>
      renderStateEntity(
        entity,
        view,
        context.volatileOf(plan.type),
        observed.get(entity.id),
      ),
    );
    return same(renderStateList(view, body, rendered), body);
  });
};

/** A list plan must reproduce each latest recording from its own envelope and the listed entities' state. */
export const checkListPlan = (
  context: StateGateContext,
  plan: StatePlan,
): StateView => {
  const union = new FieldUnion();
  const { whole, counters } = listFacts(context, plan, union);
  context.retain(union.bytes);
  const view = {
    tool: plan.tool.name,
    fields: union.fields,
    pointer: plan.pointer,
    counters,
    whole,
  };
  const all = plan.latest.every((record) => whole.has(record.ordinal));
  if (
    !plan.latest.every((record) => listReproduces(context, plan, view, record))
  )
    return recorded(plan, "list-differs");
  return {
    tool: plan.tool.name,
    shape: "list",
    type: plan.type,
    pointer: plan.pointer,
    fields: union.fields,
    required_fields: union.required,
    membership: all ? "all" : "recorded",
    ...(all || whole.size === 0
      ? {}
      : {
          all_record_ordinals: plan.latest
            .map((record) => record.ordinal)
            .filter((ordinal) => whole.has(ordinal)),
        }),
    counters,
    checked_record_ordinals: plan.latest.map((record) => record.ordinal),
  };
};
