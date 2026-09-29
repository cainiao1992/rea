/** Compare JSON-compatible replay values without recursive stack growth. */
export const replayValuesEqual = (left: unknown, right: unknown): boolean => {
  const pending: [unknown, unknown][] = [[left, right]];
  while (pending.length > 0) {
    const pair = pending.pop();
    if (pair === undefined) continue;
    const [currentLeft, currentRight] = pair;
    const primitive = equalPrimitiveReplayValues(currentLeft, currentRight);
    if (primitive !== undefined) {
      if (!primitive) return false;
      continue;
    }
    const array = compareReplayArrays(currentLeft, currentRight, pending);
    if (array !== undefined) {
      if (!array) return false;
      continue;
    }
    if (!compareReplayRecords(currentLeft, currentRight, pending)) return false;
  }
  return true;
};

/** Check that captured values can be serialized as JSON without recursion. */
export const isJsonCompatible = (value: unknown): boolean => {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const candidate = pending.pop();
    if (
      candidate === null ||
      typeof candidate === "string" ||
      typeof candidate === "boolean"
    )
      continue;
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) return false;
      continue;
    }
    if (Array.isArray(candidate)) {
      for (const item of candidate) pending.push(item);
      continue;
    }
    if (typeof candidate !== "object") return false;
    for (const item of Object.values(candidate)) pending.push(item);
  }
  return true;
};

const equalPrimitiveReplayValues = (
  left: unknown,
  right: unknown,
): boolean | undefined => {
  if (left === null || typeof left === "string" || typeof left === "boolean")
    return left === right;
  if (typeof left !== "number") return undefined;
  return (
    Number.isFinite(left) &&
    left === right &&
    typeof right === "number" &&
    Number.isFinite(right)
  );
};

const compareReplayArrays = (
  left: unknown,
  right: unknown,
  pending: [unknown, unknown][],
): boolean | undefined => {
  if (!Array.isArray(left)) return undefined;
  if (!Array.isArray(right) || left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1)
    pending.push([left[index], right[index]]);
  return true;
};

const compareReplayRecords = (
  left: unknown,
  right: unknown,
  pending: [unknown, unknown][],
): boolean | undefined => {
  if (typeof left !== "object" || left === null) return undefined;
  if (typeof right !== "object" || right === null || Array.isArray(right))
    return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (
    leftKeys.length !== rightKeys.length ||
    leftKeys.some((key, index) => key !== rightKeys[index])
  )
    return false;
  for (const key of leftKeys)
    pending.push([Reflect.get(left, key), Reflect.get(right, key)]);
  return true;
};
