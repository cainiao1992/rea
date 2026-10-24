import { z } from "zod";
import { parseBinary } from "plist";

import {
  AnalysisOutputError,
  AnalysisResourceConstraintError,
} from "../../domain/analysisErrorCore.js";
import { fixedAllowanceOptions } from "../../domain/fixedAllowanceRemediation.js";
import type { JsonValue } from "../../domain/jsonValue.js";
import {
  binaryDatePrecisionOverlapLimitation,
  negativeZeroReal,
  negativeZeroRealLimitation,
  nonFiniteRealLimitation,
  projectPlistValue,
  unknownDateLimitation,
  unknownScalarLimitation,
  type ProjectedPlistValue,
} from "../../domain/apple/plistValue.js";
import {
  omitPrototypeKeys,
  omittedPrototypeKeysLimitation,
  parseXmlPropertyList,
} from "../../domain/propertyListKeys.js";
import { err, ok, type Result } from "../../domain/result.js";

import {
  incompletePlistNumberLimitation,
  createPlistNumberProjection,
  type PlistNumberLiterals,
} from "../../domain/apple/plistNumbers.js";
import {
  decodeBinaryPlistScalars,
  scanBinaryPlistScalars,
  UnsupportedBinaryPlistUidError,
} from "../../artifacts/apple/PlistScalars.js";
import {
  estimateBinaryPlistExpansion,
  MAX_BINARY_PLIST_NESTING_DEPTH,
  PropertyListDecodeBudgetFailure,
} from "../../artifacts/apple/PropertyListDecodeBudget.js";
import { hasBinaryPlistSignature } from "../../domain/apple/appleArchiveFormat.js";

/**
 * Input ceiling matches native command output; projection is bounded separately.
 * Provisional byte allowance. This release has no runtime override.
 */
export const MAX_NATIVE_PLIST_BYTES = 64 * 1024 * 1024;
/** Provisional decode allowance. This release has no runtime override. */
const MAX_NATIVE_PLIST_DECODE_BYTES = 64 * 1024 * 1024;

const mebibytes = (bytes: number): string =>
  `${String(bytes / (1024 * 1024))} MiB`;

/** Recovery name for the fixed source-size ceiling. */
export const NATIVE_PLIST_INPUT_ALLOWANCE = `the fixed ${mebibytes(MAX_NATIVE_PLIST_BYTES)} (${String(MAX_NATIVE_PLIST_BYTES)}-byte) native plist input allowance (no runtime override)`;

const plistObject = z.record(z.string(), z.unknown());

/** Stable bundle metadata projected from one plist value. */
export interface PlistBundleMetadata {
  readonly identifier: string | null;
  readonly executable: string | null;
  readonly name: string | null;
  readonly version: string | null;
  readonly short_version: string | null;
}

/** One decoded plist with bundle metadata and decoding limitations. */
export interface ParsedPlist {
  readonly value: unknown;
  readonly bundle: PlistBundleMetadata;
  readonly limitations: readonly string[];
}

/** Digits of a JSON number literal that has no fraction or exponent. */
const INTEGRAL_LITERAL = /^-?\d+$/u;

/** An unsafe integral JSON literal, kept separate from caller-authored objects. */
class PlistJsonIntegerLiteral {
  constructor(
    readonly value: number,
    readonly digits: string,
  ) {}
}

/** One JSON parse attempt, retaining its facts or failure for final projection. */
export interface PlistJsonParseAttempt {
  /** Whether plutil should supply XML number types; false for malformed JSON. */
  readonly needsNumberTypes: boolean;
  project(xmlConversion?: string): Result<ParsedPlist, AnalysisOutputError>;
}

const plistJsonOutputError = (cause: unknown): AnalysisOutputError =>
  new AnalysisOutputError(
    "inspect_plist",
    cause instanceof Error ? cause.message : String(cause),
    { cause },
  );

/**
 * Read plutil JSON once, retaining exact unsafe integral literals. Optional XML
 * classification and each independent output projection use these same facts.
 */
export const readPlistJson = (output: string): PlistJsonParseAttempt => {
  let decoded: Result<unknown, unknown>;
  let needsNumberTypes = false;
  try {
    // plutil output can carry a UTF-8 BOM, which JSON.parse rejects outright.
    const text = output.replace(/^\uFEFF/u, "");
    decoded = ok(
      JSON.parse(
        text,
        (
          _key: string,
          item: unknown,
          context?: { readonly source?: string },
        ) => {
          const source = context?.source;
          if (
            typeof item !== "number" ||
            Number.isSafeInteger(item) ||
            source === undefined ||
            !INTEGRAL_LITERAL.test(source)
          )
            return item;
          // JSON prints integral <real> and <integer> values alike.
          needsNumberTypes = true;
          return new PlistJsonIntegerLiteral(item, source);
        },
      ),
    );
  } catch (cause: unknown) {
    decoded = err(cause);
  }
  return {
    needsNumberTypes: decoded.ok && needsNumberTypes,
    project: (xmlConversion) => projectPlistJsonAttempt(decoded, xmlConversion),
  };
};

const projectPlistJsonAttempt = (
  attempt: Result<unknown, unknown>,
  xmlConversion: string | undefined,
): Result<ParsedPlist, AnalysisOutputError> => {
  let literals: PlistNumberLiterals | undefined;
  let exactIntegerCount = 0;
  let ambiguousNumberCount = 0;
  let negativeZeroRealCount = 0;
  const project = (item: unknown): unknown => {
    // A plist integer has no signed zero, so -0 can only come from a real.
    if (typeof item === "number" && Object.is(item, -0)) {
      negativeZeroRealCount += 1;
      return negativeZeroReal();
    }
    if (item instanceof PlistJsonIntegerLiteral) {
      const integer =
        literals?.incomplete === false &&
        literals.integers.get(item.value)?.has(item.digits) === true;
      const real =
        literals?.incomplete === false && literals.reals.has(item.value);
      if (integer && !real) {
        exactIntegerCount += 1;
        return { $plist_type: "integer", decimal: item.digits };
      }
      // An integral <real> decodes exactly; only its JSON spelling is integral.
      if (real && !integer) return item.value;
      ambiguousNumberCount += 1;
      return item.value;
    }
    if (Array.isArray(item)) return item.map(project);
    if (item !== null && typeof item === "object")
      return Object.fromEntries(
        Object.entries(item).map(([key, value]) => [key, project(value)]),
      );
    return item;
  };
  let decoded: ReturnType<typeof omitPrototypeKeys>;
  try {
    // Preserve XML-before-JSON failure precedence during final projection.
    literals =
      xmlConversion === undefined
        ? undefined
        : parseXmlPropertyList(xmlConversion).numberLiterals;
    if (!attempt.ok) return err(plistJsonOutputError(attempt.error));
    // Numeric limitations also account for values under omitted source keys.
    decoded = omitPrototypeKeys(project(attempt.value));
  } catch (cause: unknown) {
    return err(plistJsonOutputError(cause));
  }
  const { value } = decoded;
  return ok({
    value,
    bundle: projectPlistBundle(value),
    limitations: [
      ...negativeZeroLimitations(negativeZeroRealCount),
      ...(literals?.incomplete === true
        ? [incompletePlistNumberLimitation]
        : []),
      ...numberLimitations(exactIntegerCount, ambiguousNumberCount),
      ...prototypeKeyLimitations(decoded.omittedPrototypeKeys),
    ],
  });
};

/**
 * Parse plutil XML output for a plist that JSON cannot express, such as one
 * containing data, dates, or non-finite reals.
 */
export const parsePlistXml = (
  output: string,
): Result<ParsedPlist, AnalysisOutputError> => {
  let projected: ProjectedPlistValue;
  let omittedPrototypeKeys: number;
  let literals: PlistNumberLiterals;
  try {
    const decoded = parseXmlPropertyList(output);
    omittedPrototypeKeys = decoded.omittedPrototypeKeys;
    literals = decoded.numberLiterals;
    projected = projectPlistValue(decoded.value);
  } catch (cause: unknown) {
    return err(
      new AnalysisOutputError(
        "inspect_plist",
        "plutil XML conversion was not a readable plist",
        { cause },
      ),
    );
  }
  // The XML decoder turns <integer> and <real> into numbers before REA sees
  // them, rounding integers beyond the exact range.
  let exactIntegerCount = 0;
  let ambiguousNumberCount = 0;
  const value = mapJsonNumbers(projected.value, (item) => {
    const decimals = literals.integers.get(item);
    if (decimals === undefined) return item;
    const [decimal] = decimals;
    if (
      literals.incomplete ||
      decimals.size !== 1 ||
      decimal === undefined ||
      literals.reals.has(item)
    ) {
      ambiguousNumberCount += 1;
      return item;
    }
    exactIntegerCount += 1;
    return { $plist_type: "integer", decimal };
  });
  return ok({
    value,
    bundle: projectPlistBundle(value),
    limitations: [
      'plutil cannot express this plist as JSON, so it was decoded from plutil\'s XML conversion; data and date values are typed objects such as { "$plist_type": "data", "base64": ... }.',
      ...projectedScalarLimitations(projected),
      ...(literals.incomplete ? [incompletePlistNumberLimitation] : []),
      ...numberLimitations(exactIntegerCount, ambiguousNumberCount),
      ...prototypeKeyLimitations(omittedPrototypeKeys),
    ],
  });
};

/** Decode binary plist source bytes before conversion can erase scalar facts. */
export const parsePlistBinary = (
  bytes: Buffer,
): Result<
  ParsedPlist,
  | AnalysisOutputError
  | AnalysisResourceConstraintError
  | UnsupportedBinaryPlistUidError
> => {
  try {
    if (!hasBinaryPlistSignature(bytes))
      throw new TypeError("selected file does not have a binary plist header");
    const expansion = estimateBinaryPlistExpansion(
      bytes,
      MAX_NATIVE_PLIST_DECODE_BYTES,
      {
        budget: "the native plist decode budget",
        numberProjection: true,
        fail: (kind, message) =>
          kind === "cycle"
            ? new TypeError(
                "binary plist object references form a cycle, which a property list cannot represent",
              )
            : new PropertyListDecodeBudgetFailure(kind, message),
      },
    );
    const scalarMetadata = scanBinaryPlistScalars(bytes, expansion);
    const decoded = parseBinary(
      decodeBinaryPlistScalars(bytes, scalarMetadata, expansion),
    );
    const projected = projectPlistValue(decoded);
    const numbers = createPlistNumberProjection(scalarMetadata.literals);
    const value = numbers.project(projected.value);
    return ok({
      value,
      bundle: projectPlistBundle(value),
      limitations: [
        ...projectedScalarLimitations(projected),
        ...(expansion.datePrecisionOverlapCount === 0
          ? []
          : [
              binaryDatePrecisionOverlapLimitation(
                expansion.datePrecisionOverlapCount,
              ),
            ]),
        ...numbers.limitations(),
        ...(expansion.binaryPrototypeKeyObserved
          ? [omittedPrototypeKeysLimitation(null)]
          : []),
      ],
    });
  } catch (cause: unknown) {
    if (cause instanceof UnsupportedBinaryPlistUidError) return err(cause);
    if (cause instanceof PropertyListDecodeBudgetFailure)
      return err(
        new AnalysisResourceConstraintError(
          "inspect_plist",
          "memory",
          cause.message,
          cause.kind === "depth"
            ? { maximum_nesting_depth: MAX_BINARY_PLIST_NESTING_DEPTH }
            : { maximum_decoded_bytes: MAX_NATIVE_PLIST_DECODE_BYTES },
          {
            cause,
            ...fixedAllowanceOptions(
              cause.kind === "depth"
                ? `The ${String(MAX_BINARY_PLIST_NESTING_DEPTH)}-level native binary plist nesting allowance (no runtime override)`
                : `The ${mebibytes(MAX_NATIVE_PLIST_DECODE_BYTES)} (${String(MAX_NATIVE_PLIST_DECODE_BYTES)}-byte) native binary plist decode allowance (no runtime override)`,
              "parser",
            ),
          },
        ),
      );
    return err(
      new AnalysisOutputError(
        "inspect_plist",
        cause instanceof Error ? cause.message : String(cause),
        { cause },
      ),
    );
  }
};

const prototypeKeyLimitations = (count: number): string[] =>
  count === 0 ? [] : [omittedPrototypeKeysLimitation(count)];

const projectedScalarLimitations = (
  projected: ProjectedPlistValue,
): string[] => [
  ...(projected.nonFiniteRealCount === 0
    ? []
    : [nonFiniteRealLimitation(projected.nonFiniteRealCount)]),
  ...negativeZeroLimitations(projected.negativeZeroRealCount),
  ...(projected.unknownDateCount === 0
    ? []
    : [unknownDateLimitation(projected.unknownDateCount)]),
  ...(projected.unknownScalarCount === 0
    ? []
    : [unknownScalarLimitation(projected.unknownScalarCount)]),
];

const negativeZeroLimitations = (count: number): string[] =>
  count === 0 ? [] : [negativeZeroRealLimitation(count)];

const numberLimitations = (
  exactIntegerCount: number,
  ambiguousNumberCount: number,
): string[] => [
  ...(exactIntegerCount === 0
    ? []
    : [
        `${String(exactIntegerCount)} integer value(s) exceed the exact range of a JSON number and are reported as { "$plist_type": "integer", "decimal": "<exact digits>" }.`,
      ]),
  ...(ambiguousNumberCount === 0
    ? []
    : [
        `${String(ambiguousNumberCount)} number(s) beyond the exact range of a JSON number are reported as decoded because the XML literal they came from, a rounded <integer> or a <real>, cannot be identified.`,
      ]),
];

const mapJsonNumbers = (
  value: JsonValue,
  map: (item: number) => JsonValue,
): JsonValue => {
  if (typeof value === "number") return map(value);
  if (Array.isArray(value))
    return value.map((item) => mapJsonNumbers(item, map));
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        mapJsonNumbers(item, map),
      ]),
    );
  return value;
};

const projectPlistBundle = (value: unknown): PlistBundleMetadata => {
  const object = plistObject.safeParse(value);
  const field = (name: string): string | null => {
    if (!object.success) return null;
    const candidate = object.data[name];
    return typeof candidate === "string" ? candidate : null;
  };
  return {
    identifier: field("CFBundleIdentifier"),
    executable: field("CFBundleExecutable"),
    name: field("CFBundleName"),
    version: field("CFBundleVersion"),
    short_version: field("CFBundleShortVersionString"),
  };
};
