import { parse as parseXmlPlist } from "plist";
import { z } from "zod";

import { AnalysisOutputError } from "../../domain/analysisErrorCore.js";
import {
  projectPlistValue,
  type ProjectedPlistValue,
} from "../../domain/plistValue.js";
import { err, ok, type Result } from "../../domain/result.js";
import { safeParseJson } from "../../domain/safeJson.js";

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
  const parsed = safeParseJson(output.replace(/^﻿/u, ""));
  if (!parsed.ok)
    return err(
      new AnalysisOutputError("inspect_plist", parsed.error, {
        cause: parsed.cause,
      }),
    );
  const value: unknown = parsed.value;
  return ok({ value, bundle: projectPlistBundle(value), limitations: [] });
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
  return ok({
    value: projected.value,
    bundle: projectPlistBundle(projected.value),
    limitations: [
      'plutil cannot express this plist as JSON, so it was decoded from plutil\'s XML conversion; data and date values are typed objects such as { "$plist_type": "data", "base64": ... }.',
      ...(projected.unknownRealCount === 0
        ? []
        : [
            `${String(projected.unknownRealCount)} non-finite real value(s) are reported as { "$plist_type": "real", "value": null } because the XML decoder does not distinguish NaN from infinity.`,
          ]),
    ],
  });
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
