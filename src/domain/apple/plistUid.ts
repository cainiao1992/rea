/** Serialized binary UID identity is separate from an ordinary dictionary's keys. */
const binaryUidValues = new WeakMap<object, number | undefined>();

/** The binary decoder marks every dictionary; only type-8 records carry a UID. */
export const markBinaryPlistDictionary = (
  value: object,
  uid?: number,
): void => {
  binaryUidValues.set(value, uid);
};

/** Preserve source identity through the single JSON projection owner. */
export const copyPlistUidIdentity = (
  source: object,
  projected: object,
): void => {
  if (binaryUidValues.has(source))
    binaryUidValues.set(projected, binaryUidValues.get(source));
};

/** XML/untyped decoded archives use Foundation's dictionary UID convention. */
export const plistUidValue = (value: unknown): number | undefined => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return undefined;
  if (binaryUidValues.has(value)) return binaryUidValues.get(value);
  const fields = Object.keys(value);
  if (fields.length !== 1) return undefined;
  const key = fields[0];
  if (key !== "UID" && key !== "CF$UID") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return typeof descriptor?.value === "number" ? descriptor.value : undefined;
};
