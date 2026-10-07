import { execFile } from "node:child_process";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { z } from "zod";

import { BinaryTargetError } from "../domain/configurationErrors.js";
import { isPathWithinRoot } from "../domain/localPath.js";
import { parseXmlPropertyList } from "../domain/propertyListKeys.js";
import { err, ok, type Result } from "../domain/result.js";

const execFileAsync = promisify(execFile);

/** Where one app bundle layout keeps its Info.plist and program file. */
interface BundleLayout {
  readonly plist: readonly string[];
  readonly programs: readonly string[];
  readonly programsLabel: string;
}

const BUNDLE_LAYOUTS: readonly BundleLayout[] = [
  // macOS bundles keep both under Contents.
  {
    plist: ["Contents", "Info.plist"],
    programs: ["Contents", "MacOS"],
    programsLabel: "Contents/MacOS",
  },
  // iOS-style bundles, as extracted from an IPA, keep both at the root.
  { plist: ["Info.plist"], programs: [], programsLabel: "the bundle root" },
];

/**
 * Resolve an app bundle directory to its declared program file. macOS and
 * flat iOS-style layouts are read directly. An iOS app installed on a Mac is
 * a wrapper whose `Wrapper` directory holds the iOS bundle; that bundle is
 * found by listing `Wrapper`, never by following the `WrappedBundle` link.
 */
export const resolveAppBundleExecutable = async (
  path: string,
): Promise<Result<string, BinaryTargetError>> => {
  const layout = await presentLayout(path);
  if (layout !== undefined) return resolveLayoutExecutable(path, layout);
  const wrapped = await wrappedBundle(path);
  if (wrapped !== undefined) {
    const wrappedLayout = await presentLayout(wrapped);
    if (wrappedLayout !== undefined)
      return resolveLayoutExecutable(wrapped, wrappedLayout);
  }
  return err(
    new BinaryTargetError(path, "app has no readable CFBundleExecutable", {
      cause: new Error(
        "No Contents/Info.plist, root Info.plist, or single Wrapper/*.app bundle was found",
      ),
    }),
  );
};

const presentLayout = async (
  bundle: string,
): Promise<BundleLayout | undefined> => {
  for (const layout of BUNDLE_LAYOUTS)
    if (await isRegularFile(join(bundle, ...layout.plist))) return layout;
  return undefined;
};

const isRegularFile = async (path: string): Promise<boolean> => {
  try {
    return (await lstat(path)).isFile();
  } catch {
    return false;
  }
};

/** The single real `.app` directory inside an iOS-on-Mac `Wrapper`. */
const wrappedBundle = async (bundle: string): Promise<string | undefined> => {
  const wrapper = join(bundle, "Wrapper");
  try {
    if (!(await lstat(wrapper)).isDirectory()) return undefined;
    const apps = (await readdir(wrapper, { withFileTypes: true })).filter(
      (entry) =>
        entry.isDirectory() && entry.name.toLowerCase().endsWith(".app"),
    );
    const [app] = apps;
    return apps.length === 1 && app !== undefined
      ? join(wrapper, app.name)
      : undefined;
  } catch {
    return undefined;
  }
};

const resolveLayoutExecutable = async (
  bundle: string,
  layout: BundleLayout,
): Promise<Result<string, BinaryTargetError>> => {
  const plistPath = join(bundle, ...layout.plist);
  let name: string;
  try {
    const plist = await readFile(plistPath);
    name =
      plist.subarray(0, 6).toString("ascii") === "bplist"
        ? await readBinaryPlistExecutable(plistPath)
        : parseXmlPlistExecutable(plist.toString("utf8"));
  } catch (cause: unknown) {
    return err(
      new BinaryTargetError(bundle, "app has no readable CFBundleExecutable", {
        cause,
      }),
    );
  }
  if (!isSafeExecutableName(name))
    return err(
      new BinaryTargetError(bundle, "app has an unsafe CFBundleExecutable"),
    );
  const programs = join(bundle, ...layout.programs);
  const executable = join(programs, name);
  try {
    const [canonicalPrograms, canonicalExecutable] = await Promise.all([
      realpath(programs),
      realpath(executable),
    ]);
    if (!isPathWithinRoot(canonicalPrograms, canonicalExecutable))
      return err(
        new BinaryTargetError(
          bundle,
          `app program file leaves ${layout.programsLabel}`,
        ),
      );
    return ok(canonicalExecutable);
  } catch (cause: unknown) {
    return err(
      new BinaryTargetError(bundle, "app program file is missing", { cause }),
    );
  }
};

/** Decode the top-level executable name with an XML parser, not a pattern. */
const parseXmlPlistExecutable = (plist: string): string => {
  // An unrelated `__proto__` entry must not make the bundle unreadable.
  const { value } = parseXmlPropertyList(plist);
  const executable = executableEntrySchema.safeParse(value);
  if (!executable.success) throw new Error("CFBundleExecutable is missing");
  return executable.data.CFBundleExecutable;
};

const executableEntrySchema = z.looseObject({ CFBundleExecutable: z.string() });

const readBinaryPlistExecutable = async (plistPath: string): Promise<string> =>
  // `-n` strips only the newline plutil appends; it requires macOS 12+.
  (
    await execFileAsync("/usr/bin/plutil", [
      "-extract",
      "CFBundleExecutable",
      "raw",
      "-n",
      "-o",
      "-",
      plistPath,
    ])
  ).stdout;

const isSafeExecutableName = (name: string): boolean =>
  name.length > 0 &&
  name !== "." &&
  name !== ".." &&
  !name.includes("\0") &&
  !/[/\\]/u.test(name);
