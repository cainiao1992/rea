/** Distinguish corrupt recognized binaries from containers outside parser coverage. */
export class BinaryFormatFailure extends Error {
  constructor(
    readonly kind: "malformed" | "unsupported",
    message: string,
  ) {
    super(message);
    this.name = "BinaryFormatFailure";
  }
}

/** A missing file span is a candidate miss; conflicting owners are malformed. */
export class BinaryMappingFailure extends BinaryFormatFailure {
  constructor(
    readonly reason: "unmapped" | "ambiguous",
    message: string,
  ) {
    super("malformed", message);
  }
}

/** Resource boundary exceeded while decoding metadata or native container structure. */
export class BinaryResourceFailure extends Error {
  constructor(
    readonly boundary: "build-info" | "structure" | "search",
    readonly maximum_bytes: number,
    message: string,
  ) {
    super(message);
    this.name = "BinaryResourceFailure";
  }
}

/** One file-backed virtual range; addresses stay exact until mapped to file offsets. */
export interface FileMapping {
  readonly address: bigint;
  readonly offset: number;
  readonly size: number;
}

/** Declared zero-initialized virtual memory with no corresponding file bytes. */
export interface ZeroFillMapping {
  readonly address: bigint;
  readonly size: bigint;
}

/** Native loader region facts; language-specific fallback selection belongs to consumers. */
export interface LoadRegion {
  readonly mapping: FileMapping;
  readonly memory_size: bigint;
  readonly read: boolean;
  readonly write: boolean;
  readonly execute: boolean;
  /** Raw Mach-O VM_PROT masks preserve bits not represented by booleans. */
  readonly protection_masks?: {
    readonly current: number;
    readonly maximum: number;
  };
}

/** Parsed section facts; consumer metadata validity is separate from native structure. */
export type ImageSection = {
  readonly offset: number;
  readonly size: number;
  readonly file_backed: boolean;
  readonly read_only: boolean;
  readonly compressed: boolean;
} & (
  | {
      readonly format: "elf";
      /** Null when the ELF name table is unavailable or this name is unreadable. */
      readonly name: string | null;
      readonly type: number;
      readonly address: bigint;
      readonly declared_range: {
        readonly offset: bigint;
        readonly size: bigint;
      };
    }
  | {
      readonly format: "pe";
      readonly name: string;
      readonly virtual_address: number;
      readonly virtual_size: number;
      readonly raw_size: number;
      readonly file_alignment: number;
      readonly characteristics: number;
    }
  | {
      readonly format: "macho";
      readonly name: string;
      readonly section_name: string;
      readonly type: number;
      readonly address: bigint;
      readonly declared_range: {
        readonly offset: bigint;
        readonly size: bigint;
      };
      readonly segment_mapping: FileMapping | null;
      readonly segment_unmapped: boolean;
    }
);

/** Declared PT_DYNAMIC file extent, before consumer-specific admission. */
export interface ElfDynamicSegment {
  readonly offset: bigint;
  readonly size: bigint;
}

/** Native container facts, without language metadata search policy. */
interface BinaryContainerFacts {
  readonly architecture: string;
  readonly bits: 32 | 64;
  readonly byte_order: "little" | "big";
  /** Declared PE preferred base, when available. */
  readonly image_base?: bigint;
  /**
   * File-backed PE headers (`SizeOfHeaders`, clipped to the file), which the
   * loader maps at the image base. Kept apart from section `mappings`.
   */
  readonly pe_header_mapping?: FileMapping;
  /** PE optional-header data directories, indexed as declared. */
  readonly pe_data_directories?: readonly {
    readonly virtual_address: number;
    readonly size: number;
  }[];
  /** Mach-O load-command observation, when available. */
  readonly macho_chained_fixups?: boolean;
  /** Section-name lookup was incomplete; absence by name is not established. */
  readonly section_names_limitation?: string;
  readonly mappings: readonly FileMapping[];
  readonly load_regions?: readonly LoadRegion[];
  /** File-backed ranges the native loader marks executable. */
  readonly executable_mappings?: readonly FileMapping[];
  readonly zero_fills: readonly ZeroFillMapping[];
  readonly sections: readonly ImageSection[];
}

/** ELF identity and dynamic declarations are present only for an ELF container. */
export type BinaryContainer = BinaryContainerFacts &
  (
    | {
        readonly format: "elf";
        readonly elf: {
          readonly machine: number;
          readonly dynamicSegments: readonly ElfDynamicSegment[];
        };
      }
    | { readonly format: "pe" | "macho" }
  );

/** All declared file-backed image memory, including PE headers at the image base. */
export const imageFileMappings = (
  container: BinaryContainer,
): readonly FileMapping[] =>
  container.pe_header_mapping === undefined
    ? container.mappings
    : [container.pe_header_mapping, ...container.mappings];

/** Reader that checks every structural range before decoding numeric fields. */
export class BinaryReader {
  constructor(
    readonly bytes: Buffer,
    readonly little: boolean,
  ) {}

  range(offset: number, size: number, label: string): Buffer {
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(size) ||
      offset < 0 ||
      size < 0 ||
      offset > this.bytes.length ||
      size > this.bytes.length - offset
    )
      throw new BinaryFormatFailure(
        "malformed",
        `${label} range is truncated or outside the file`,
      );
    return this.bytes.subarray(offset, offset + size);
  }

  u16(offset: number): number {
    const value = this.range(offset, 2, "16-bit field");
    return this.little ? value.readUInt16LE() : value.readUInt16BE();
  }

  u32(offset: number): number {
    const value = this.range(offset, 4, "32-bit field");
    return this.little ? value.readUInt32LE() : value.readUInt32BE();
  }

  word(offset: number, bits: 32 | 64): bigint {
    if (bits === 32) return BigInt(this.u32(offset));
    const value = this.range(offset, 8, "64-bit field");
    return this.little ? value.readBigUInt64LE() : value.readBigUInt64BE();
  }

  fileRange(offset: bigint, size: bigint, label: string): FileMapping {
    if (
      offset > BigInt(this.bytes.length) ||
      size > BigInt(this.bytes.length) - offset
    )
      throw new BinaryFormatFailure(
        "malformed",
        `${label} range is outside the file`,
      );
    const result = { address: 0n, offset: Number(offset), size: Number(size) };
    this.range(result.offset, result.size, label);
    return result;
  }

  table(offset: bigint, count: number, width: number, label: string): number {
    const size = BigInt(count) * BigInt(width);
    if (size > 16n * 1024n * 1024n)
      throw new BinaryResourceFailure(
        "structure",
        16 * 1024 * 1024,
        `${label} exceeds the 16 MiB structural decoding budget`,
      );
    return this.fileRange(offset, size, label).offset;
  }
}

/** Admit a declared file span, or mark it unbacked when it leaves the file. */
export const declaredFileRange = (
  fileBytes: number,
  offset: bigint,
  size: bigint,
): {
  readonly offset: number;
  readonly size: number;
  readonly file_backed: boolean;
} => {
  if (
    offset < 0n ||
    size < 0n ||
    offset > BigInt(Number.MAX_SAFE_INTEGER) ||
    size > BigInt(Number.MAX_SAFE_INTEGER) ||
    offset > BigInt(fileBytes) ||
    size > BigInt(fileBytes) - offset
  )
    return { offset: 0, size: 0, file_backed: false };
  return {
    offset: Number(offset),
    size: Number(size),
    file_backed: size > 0n,
  };
};

/** Map a physically contiguous virtual span across consistent adjacent ranges. */
export const mappedFileOffset = (
  mappings: readonly FileMapping[],
  address: bigint,
  size: number,
  zeroFills: readonly ZeroFillMapping[] = [],
): number => {
  if (!Number.isSafeInteger(size) || size < 0)
    throw new BinaryFormatFailure("malformed", "Virtual span size is invalid");
  const end = address + BigInt(size);
  let found: number | undefined;
  const covered: { start: bigint; end: bigint }[] = [];
  let whollyCovered = size === 0;
  for (const mapping of mappings) {
    const mappingEnd = mapping.address + BigInt(mapping.size);
    const start = address > mapping.address ? address : mapping.address;
    const overlapEnd = end < mappingEnd ? end : mappingEnd;
    if (
      size === 0
        ? address < mapping.address || address > mappingEnd
        : start >= overlapEnd
    )
      continue;
    const origin = mapping.offset + Number(address - mapping.address);
    if (found !== undefined && found !== origin)
      throw new BinaryMappingFailure(
        "ambiguous",
        "Virtual span has ambiguous or noncontiguous file mappings",
      );
    found = origin;
    if (start === address && overlapEnd === end) whollyCovered = true;
    else if (!whollyCovered) covered.push({ start, end: overlapEnd });
  }
  if (found === undefined)
    throw new BinaryMappingFailure(
      "unmapped",
      "Virtual address or string range is not file mapped",
    );
  if (!whollyCovered) {
    covered.sort((left, right) =>
      left.start < right.start ? -1 : left.start > right.start ? 1 : 0,
    );
    let cursor = address;
    for (const span of covered) {
      if (span.start > cursor)
        throw new BinaryMappingFailure(
          "unmapped",
          "Virtual address or string range is not file mapped",
        );
      if (span.end > cursor) cursor = span.end;
    }
    if (cursor < end)
      throw new BinaryMappingFailure(
        "unmapped",
        "Virtual address or string range is not file mapped",
      );
  }
  for (const zeroFill of zeroFills) {
    if (spansOverlap(address, BigInt(size), zeroFill.address, zeroFill.size))
      throw new BinaryMappingFailure(
        "ambiguous",
        "Virtual address has ambiguous file and zero-fill mappings",
      );
  }
  return found;
};

/** Read a bounded NUL-terminated string while retaining mapping/alias semantics. */
export const readMappedCString = (
  bytes: Buffer,
  image: BinaryContainer,
  address: bigint,
  maximumBytes: number,
): Buffer => {
  const mappings = imageFileMappings(image);
  const chunks: Buffer[] = [];
  let length = 0;
  while (length <= maximumBytes) {
    const cursor = address + BigInt(length);
    const mapping = mappings.find(
      (range) =>
        range.address <= cursor && cursor < range.address + BigInt(range.size),
    );
    if (mapping === undefined) {
      mappedFileOffset(mappings, cursor, 1, image.zero_fills);
      throw new BinaryMappingFailure(
        "unmapped",
        "String range is not file mapped",
      );
    }
    const size = Math.min(
      maximumBytes + 1 - length,
      Number(mapping.address + BigInt(mapping.size) - cursor),
    );
    const offset = mapping.offset + Number(cursor - mapping.address);
    const chunk = bytes.subarray(offset, offset + size);
    const terminator = chunk.indexOf(0);
    const consumed = terminator < 0 ? size : terminator + 1;
    mappedFileOffset(mappings, cursor, consumed, image.zero_fills);
    if (terminator >= 0) {
      const tail = chunk.subarray(0, terminator);
      if (chunks.length === 0) return tail;
      chunks.push(tail);
      return Buffer.concat(chunks, length + terminator);
    }
    chunks.push(chunk);
    length += size;
  }
  throw new BinaryFormatFailure(
    "malformed",
    `String is unterminated or longer than ${String(maximumBytes)} bytes`,
  );
};

/** Recognize a wholly zero-filled span while refusing even partial file aliases. */
export const isZeroFilledSpan = (
  mappings: readonly FileMapping[],
  zeroFills: readonly ZeroFillMapping[],
  address: bigint,
  size: number,
): boolean => {
  const bytes = BigInt(size);
  if (
    !zeroFills.some(
      (mapping) =>
        address >= mapping.address &&
        address + bytes <= mapping.address + mapping.size,
    )
  )
    return false;
  for (const mapping of mappings) {
    if (spansOverlap(address, bytes, mapping.address, BigInt(mapping.size)))
      throw new BinaryMappingFailure(
        "ambiguous",
        "Virtual address has ambiguous file and zero-fill mappings",
      );
  }
  return true;
};

const spansOverlap = (
  address: bigint,
  size: bigint,
  otherAddress: bigint,
  otherSize: bigint,
): boolean =>
  size > 0n &&
  otherSize > 0n &&
  address < otherAddress + otherSize &&
  otherAddress < address + size;
