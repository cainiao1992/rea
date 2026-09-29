import {
  browserOriginSchema,
  sanitizeBrowserUrl,
} from "../domain/browserObservation.js";
import type { JavaScriptRuntimeLocation } from "../domain/javascriptRuntimeObservation.js";
import { authorizedElectronFile } from "./ElectronFileScope.js";

export type RuntimeLocationDecision =
  | { readonly allowed: true; readonly location: JavaScriptRuntimeLocation }
  | {
      readonly allowed: false;
      readonly reason: "unsupported_location";
    };

/** Resolve a protocol location exposed by the explicitly selected Inspector endpoint. */
export const authorizeRuntimeLocation = async (
  value: string,
): Promise<RuntimeLocationDecision> => {
  if (value.startsWith("node:") && value.length > 0)
    return {
      allowed: true,
      location: { kind: "builtin", specifier: value },
    };
  if (value.startsWith("file:")) {
    const filePath = await authorizedElectronFile(value);
    return filePath === undefined
      ? { allowed: false, reason: "unsupported_location" }
      : { allowed: true, location: { kind: "file", file_path: filePath } };
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { allowed: false, reason: "unsupported_location" };
  }
  if (!["http:", "https:"].includes(url.protocol))
    return { allowed: false, reason: "unsupported_location" };
  const parsedOrigin = browserOriginSchema.safeParse(url.origin);
  if (!parsedOrigin.success)
    return { allowed: false, reason: "unsupported_location" };
  return {
    allowed: true,
    location: {
      kind: "url",
      origin: parsedOrigin.data,
      sanitized_url: sanitizeBrowserUrl(value).url,
    },
  };
};

/** Authorize a target whose Node Inspector URL omits its main entry path. */
export const authorizeRuntimeTargetLocation = async (
  value: string,
): Promise<RuntimeLocationDecision> => authorizeRuntimeLocation(value);
