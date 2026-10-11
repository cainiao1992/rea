import type { BinaryArchitecture } from "../domain/binaryTargetTypes.js";

/** Bound Ghidra language for a caller-supplied raw-binary architecture. */
export interface GhidraRawBinaryLanguage {
  readonly languageId: string;
  readonly compilerSpecId: "default";
}

/**
 * Map the four caller-visible CPU families to little-endian generic Ghidra
 * languages. Big-endian, Thumb-only, and Cortex-M variants are out of scope.
 */
export const ghidraRawBinaryLanguage = (
  architecture: Exclude<BinaryArchitecture, "mips">,
): GhidraRawBinaryLanguage => {
  switch (architecture) {
    case "x86":
      return { languageId: "x86:LE:32:default", compilerSpecId: "default" };
    case "x86_64":
      return { languageId: "x86:LE:64:default", compilerSpecId: "default" };
    case "arm":
      return { languageId: "ARM:LE:32:v7", compilerSpecId: "default" };
    case "arm64":
      return { languageId: "AARCH64:LE:64:v8A", compilerSpecId: "default" };
  }
};
