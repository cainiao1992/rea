import { parse as parseXmlPlist } from "plist";
import { z } from "zod";

import { AnalysisOutputError } from "../../domain/analysisErrorCore.js";
import type { JsonValue } from "../../domain/jsonValue.js";
import {
  projectPlistValue,
  type ProjectedPlistValue,
} from "../../domain/plistValue.js";
import { err, ok, type Result } from "../../domain/result.js";

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

/** Parse plutil JSON output and project stable bundle metadata. */
export const parsePlistJson = (
  output: string,
): Result<ParsedPlist, AnalysisOutputError> => {
  // plutil output can carry a UTF-8 BOM, which JSON.parse rejects outright.
  const text = output.replace(/^\uFEFF/u, "");
  let exactIntegerCount = 0;
  // A plist integer can exceed the exact range of a JavaScript number; keep
  // its decimal text from the JSON source instead of a rounded value.
  const keepExactIntegers = (
    _key: string,
    item: unknown,
    context?: { readonly source?: string },
  ): unknown => {
    const source = context?.source;
    if (
      typeof item !== "number" ||
      Number.isSafeInteger(item) ||
      source === undefined ||
      !/^-?\d+$/u.test(source)
    )
      return item;
    exactIntegerCount += 1;
    return { $plist_type: "integer", decimal: source };
  };
  let value: unknown;
  try {
    value = JSON.parse(text, keepExactIntegers);
  } catch (cause: unknown) {
    return err(
      new AnalysisOutputError(
        "inspect_plist",
        cause instanceof Error ? cause.message : String(cause),
        { cause },
      ),
    );
  }
  return ok({
    value,
    bundle: projectPlistBundle(value),
    limitations:
      exactIntegerCount === 0
        ? []
        : [largeIntegerLimitation(exactIntegerCount)],
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
  try {
    projected = projectPlistValue(parseXmlPlist(output));
  } catch (cause: unknown) {
    return err(
      new AnalysisOutputError(
        "inspect_plist",
        "plutil XML conversion was not a readable plist",
        { cause },
      ),
    );
  }
  let unknownIntegerCount = 0;
  // The XML decoder parses integers into numbers before REA sees their text,
  // so a value outside the exact range is already rounded and stays unknown.
  const value = mapJsonNumbers(projected.value, (item) => {
    if (!Number.isInteger(item) || Number.isSafeInteger(item)) return item;
    unknownIntegerCount += 1;
    return { $plist_type: "integer", decimal: null };
  });
  return ok({
    value,
    bundle: projectPlistBundle(value),
    limitations: [
      'plutil cannot express this plist as JSON, so it was decoded from plutil\'s XML conversion; data and date values are typed objects such as { "$plist_type": "data", "base64": ... }.',
      ...(projected.unknownRealCount === 0
        ? []
        : [
            `${String(projected.unknownRealCount)} non-finite real value(s) are reported as { "$plist_type": "real", "value": null } because the XML decoder does not distinguish NaN from infinity.`,
          ]),
      ...(unknownIntegerCount === 0
        ? []
        : [
            `${String(unknownIntegerCount)} integer value(s) exceed the exact range of a JSON number and are reported as { "$plist_type": "integer", "decimal": null } because the XML decoder rounds them.`,
          ]),
    ],
  });
};

const largeIntegerLimitation = (count: number): string =>
  `${String(count)} integer value(s) exceed the exact range of a JSON number and are reported as { "$plist_type": "integer", "decimal": "<exact digits>" }.`;

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
