/** Normalize a u64 selector without allocating a BigInt for unbounded digits. */
export const normalizeKunaAddress = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const match = /^0x0*([0-9a-f]{1,16})$/iu.exec(value);
  return match?.[1] === undefined
    ? undefined
    : `0x${BigInt(`0x${match[1]}`).toString(16)}`;
};
