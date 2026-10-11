import { posix } from "node:path";

/** Why a device-reported path cannot be used as a host file name. */
export type AdbHostFileNameReason =
  | "empty_file_name"
  | "dot_segment"
  | "path_separator"
  | "control_character"
  | "unsupported_character"
  | "reserved_name"
  | "trailing_dot_or_space"
  | "alternate_data_stream";

/** A portable host file name, or the exact reason the device name was refused. */
export type AdbHostFileNameResult =
  | { readonly ok: true; readonly fileName: string }
  | { readonly ok: false; readonly reason: AdbHostFileNameReason };

/**
 * Win32 resolves these basenames to a device regardless of case and of any
 * extension (`NUL`, `nul.txt`), so a portable host file name must avoid them on
 * every host. `(?:\.|$)` keeps ordinary names such as `console.txt` admissible.
 */
const WINDOWS_RESERVED_BASENAME =
  /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;

/** Characters that are not portable in a host file name on Windows or POSIX. */
const UNSUPPORTED_CHARACTER = /[*?"<>|]/u;

/** Control characters (`Cc`), including C0 controls and DEL. */
const CONTROL_CHARACTER = /\p{Cc}/u;

/**
 * Derive a portable host file name from a device-reported path.
 *
 * The device path is a POSIX path on the device filesystem, so its last
 * `/`-separated segment is taken with POSIX semantics rather than the host
 * `basename` (which would vary between POSIX and Windows hosts). A name is
 * accepted only when every host can store it and address it back unambiguously:
 * no separator, control, or reserved-device characters, no trailing dot or
 * space, no `:` alternate-data-stream marker, and no `.`/`..` segment.
 */
export const adbHostFileName = (devicePath: string): AdbHostFileNameResult => {
  const fileName = posix.basename(devicePath);
  if (fileName === "") return { ok: false, reason: "empty_file_name" };
  if (fileName === "." || fileName === "..")
    return { ok: false, reason: "dot_segment" };
  if (fileName.includes("\\") || fileName.includes("/"))
    return { ok: false, reason: "path_separator" };
  if (CONTROL_CHARACTER.test(fileName))
    return { ok: false, reason: "control_character" };
  if (fileName.includes(":"))
    return { ok: false, reason: "alternate_data_stream" };
  if (UNSUPPORTED_CHARACTER.test(fileName))
    return { ok: false, reason: "unsupported_character" };
  if (WINDOWS_RESERVED_BASENAME.test(fileName))
    return { ok: false, reason: "reserved_name" };
  if (/[. ]$/u.test(fileName))
    return { ok: false, reason: "trailing_dot_or_space" };
  return { ok: true, fileName };
};
