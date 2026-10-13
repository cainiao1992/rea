interface MachoArchitecturePolicy {
  readonly cpuType: number;
  readonly subtypes: readonly {
    readonly subtype: number;
    readonly name: string;
  }[];
  readonly variantName?: RegExp;
}

/** One preference order for FAT subtype identities and Apple tool slice names. */
export const MACHO_ARCHITECTURE_POLICIES: Readonly<
  Record<string, MachoArchitecturePolicy>
> = {
  x86: { cpuType: 7, subtypes: [{ subtype: 3, name: "i386" }] },
  x86_64: {
    cpuType: 0x01000007,
    subtypes: [{ subtype: 3, name: "x86_64" }],
  },
  arm: { cpuType: 12, subtypes: [], variantName: /^arm$/u },
  arm64: {
    cpuType: 0x0100000c,
    subtypes: [
      { subtype: 0, name: "arm64" },
      { subtype: 2, name: "arm64e" },
      { subtype: 1, name: "arm64v8" },
    ],
    variantName: /^arm64e\.[A-Za-z0-9_]+$/u,
  },
};

/** High subtype bits carry capabilities, such as the arm64e PAC ABI version. */
export const baseMachoCpuSubtype = (subtype: number): number =>
  subtype & 0x00ffffff;

/** Unlisted subtypes follow the preferred slices in FAT table order. */
export const machoSubtypeRank = (
  policy: MachoArchitecturePolicy,
  subtype: number,
): number => {
  const rank = policy.subtypes.findIndex(
    (candidate) => candidate.subtype === baseMachoCpuSubtype(subtype),
  );
  return rank < 0 ? policy.subtypes.length : rank;
};

/** Select a tool spelling using the same preference order as FAT selection. */
export const selectMachoArchitectureName = (
  policy: MachoArchitecturePolicy,
  available: readonly string[],
): string | undefined => {
  for (const { name } of policy.subtypes)
    if (available.includes(name)) return name;
  return available.find((name) => policy.variantName?.test(name));
};
