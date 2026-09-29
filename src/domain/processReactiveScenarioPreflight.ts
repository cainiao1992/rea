import { z } from "zod";

interface ReactivePreflightLimits {
  readonly triggerDepth: number;
  readonly jsonDepth: number;
}

type PendingTrigger = { readonly value: unknown; readonly depth: number };

interface TriggerTraversal {
  readonly pending: PendingTrigger[];
  readonly context: z.RefinementCtx;
  readonly limits: ReactivePreflightLimits;
}

const isUnknownRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const reject = (context: z.RefinementCtx, message: string): false => {
  context.addIssue({ code: "custom", message });
  return false;
};

const inspectJsonValue = (
  value: unknown,
  context: z.RefinementCtx,
  limits: ReactivePreflightLimits,
): boolean => {
  const pending: PendingTrigger[] = [{ value, depth: 1 }];
  const seen = new WeakSet<object>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    if (current.depth > limits.jsonDepth)
      return reject(
        context,
        "event exact JSON exceeds the configured depth limit",
      );
    if (typeof current.value !== "object" || current.value === null) continue;
    if (seen.has(current.value))
      return reject(context, "event exact JSON must not contain cycles");
    seen.add(current.value);
    if (Array.isArray(current.value)) {
      for (const child of current.value)
        pending.push({ value: child, depth: current.depth + 1 });
      continue;
    }
    if (!isUnknownRecord(current.value)) continue;
    for (const key in current.value) {
      if (!Object.hasOwn(current.value, key)) continue;
      pending.push({
        value: current.value[key],
        depth: current.depth + 1,
      });
    }
  }
  return true;
};

const collectTriggerRoots = (states: readonly unknown[]): PendingTrigger[] => {
  const pending: PendingTrigger[] = [];
  for (const stateValue of states) {
    if (!isUnknownRecord(stateValue) || !Array.isArray(stateValue["on"]))
      continue;
    for (const transitionValue of stateValue["on"])
      if (isUnknownRecord(transitionValue))
        pending.push({ value: transitionValue["when"], depth: 1 });
  }
  return pending;
};

const enqueueTriggerChildren = (
  trigger: Record<string, unknown>,
  depth: number,
  traversal: TriggerTraversal,
): boolean => {
  if (trigger["kind"] === "repeat") {
    traversal.pending.push({ value: trigger["trigger"], depth: depth + 1 });
    return true;
  }
  if (
    trigger["kind"] !== "all" &&
    trigger["kind"] !== "any" &&
    trigger["kind"] !== "sequence"
  )
    return true;
  const children = trigger["triggers"];
  if (!Array.isArray(children)) return true;
  for (const child of children)
    traversal.pending.push({ value: child, depth: depth + 1 });
  return true;
};

const inspectTriggerTree = (
  pending: PendingTrigger[],
  context: z.RefinementCtx,
  limits: ReactivePreflightLimits,
): boolean => {
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    if (current.depth > limits.triggerDepth)
      return reject(context, "trigger nesting exceeds the configured limit");
    if (
      isUnknownRecord(current.value) &&
      current.value["kind"] === "event" &&
      !inspectJsonValue(current.value["exact"], context, limits)
    )
      return false;
    if (
      isUnknownRecord(current.value) &&
      !enqueueTriggerChildren(current.value, current.depth, {
        pending,
        context,
        limits,
      })
    )
      return false;
  }
  return true;
};

/** Reject oversized unknown trees before the recursive Zod schema visits them. */
export const preflightProcessReactiveScenario = (
  input: unknown,
  context: z.RefinementCtx,
  limits: ReactivePreflightLimits,
): unknown => {
  if (!isUnknownRecord(input) || !Array.isArray(input["states"])) return input;
  const pending = collectTriggerRoots(input["states"]);
  if (!inspectTriggerTree(pending, context, limits)) return z.NEVER;
  return input;
};
