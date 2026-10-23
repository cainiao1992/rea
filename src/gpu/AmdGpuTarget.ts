const processor = String.raw`gfx[0-9a-z]+(?:-[0-9a-z]+)*`;
const targetIdSource = `${processor}(?:(?::[a-z0-9_-]+[+-])|(?:\\+[a-z0-9_-]+))*`;
const targetId = new RegExp(`^${targetIdSource}$`, "iu");
const bundleTriple =
  /^(?:hip|hipv4)-(?:amdgcn|amdgpu(?:[0-9]+(?:\.[0-9a-f]+)?)?)-amd-amdhsa-/iu;
const bundleTarget = new RegExp(`(?:--|-)(${targetIdSource})$`, "iu");
const noteTarget = new RegExp(
  `^amdgcn-amd-amdhsa(?:--|-unknown-)(${targetIdSource})$`,
  "iu",
);

/** Target IDs retain the processor spelling and any declared feature modifiers. */
export const parseAmdGpuTargetId = (value: string): string | null =>
  targetId.test(value) ? value : null;

/** Clang HIP bundle IDs carry an AMD triple followed by an optional target ID. */
export const isAmdGpuBundleId = (name: string): boolean =>
  bundleTriple.test(name);

export const readAmdGpuBundleTarget = (name: string): string | null => {
  if (!isAmdGpuBundleId(name)) return null;
  const target = bundleTarget.exec(name)?.[1];
  return target === undefined ? null : parseAmdGpuTargetId(target);
};

/** Extract the processor identity from the two LLVM AMDGPU note spellings. */
export const readAmdGpuNoteTargetKey = (target: string): string | null =>
  noteTarget.exec(target)?.[1] ?? null;
