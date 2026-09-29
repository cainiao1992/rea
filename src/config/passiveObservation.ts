import { ConfigurationError } from "../domain/errors.js";
import type { PermissionCeiling } from "../domain/permissionPolicy.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  browserEndpointSchema,
  browserOriginSchema,
} from "../domain/browserObservation.js";
import type { Environment } from "./environment.js";
import { parseBrowserArray } from "./parsers.js";
import { browserNetworkScope, permissionScope } from "./permissions.js";

type DisabledObservationPolicy = { readonly status: "disabled" };

/** Parsed authority scope for passive browser observation. */
export type BrowserObservationPolicy =
  | DisabledObservationPolicy
  | {
      readonly status: "enabled";
      readonly cdpEndpoints: readonly [string, ...string[]];
      readonly allowedOrigins: readonly [string, ...string[]];
    };

/** Parsed authority scope for passive Electron observation. */
export type ElectronObservationPolicy =
  | DisabledObservationPolicy
  | { readonly status: "enabled" };

/** Parsed authority scope for passive V8 Inspector observation. */
export type V8InspectorObservationPolicy =
  | DisabledObservationPolicy
  | { readonly status: "enabled" };

/** Complete parsed passive-observation policy family. */
export interface PassiveObservationPolicies {
  readonly browser: BrowserObservationPolicy;
  readonly electron: ElectronObservationPolicy;
  readonly v8Inspector: V8InspectorObservationPolicy;
}

/** Parse every passive observation capability into closed policy variants. */
export const parsePassiveObservationPolicies = (
  env: Environment,
): Result<PassiveObservationPolicies, ConfigurationError> => {
  const browser = parseBrowserObservationPolicy(env);
  if (!browser.ok) return browser;
  const electron = parseElectronObservationPolicy(env);
  if (!electron.ok) return electron;
  const v8Inspector = parseV8InspectorObservationPolicy(env);
  if (!v8Inspector.ok) return v8Inspector;
  return ok({
    browser: browser.value,
    electron: electron.value,
    v8Inspector: v8Inspector.value,
  });
};

/** Add permission ceilings for each enabled passive observation policy. */
export const appendPassiveObservationCeilings = (
  ceilings: PermissionCeiling[],
  policies: PassiveObservationPolicies,
): void => {
  appendBrowserCeiling(ceilings, policies.browser);
  appendElectronCeiling(ceilings, policies.electron);
  appendV8InspectorCeiling(ceilings, policies.v8Inspector);
};

const parseBrowserObservationPolicy = (
  env: Environment,
): Result<BrowserObservationPolicy, ConfigurationError> => {
  const endpoints = parseBrowserArray(
    env.REA_BROWSER_CDP_ENDPOINTS_JSON,
    "REA_BROWSER_CDP_ENDPOINTS_JSON",
    browserEndpointSchema,
    16,
  );
  if (!endpoints.ok) return endpoints;
  const origins = parseBrowserArray(
    env.REA_BROWSER_ALLOWED_ORIGINS_JSON,
    "REA_BROWSER_ALLOWED_ORIGINS_JSON",
    browserOriginSchema,
    32,
  );
  if (!origins.ok) return origins;
  if (env.REA_BROWSER_OBSERVE_ENABLED !== "true")
    return ok({ status: "disabled" });
  const parsedEndpoints = requireFirst(
    endpoints.value,
    "REA_BROWSER_CDP_ENDPOINTS_JSON must encode at least one loopback endpoint when browser observation is enabled",
  );
  if (!parsedEndpoints.ok) return parsedEndpoints;
  const parsedOrigins = requireFirst(
    origins.value,
    "REA_BROWSER_ALLOWED_ORIGINS_JSON must encode at least one exact origin when browser observation is enabled",
  );
  if (!parsedOrigins.ok) return parsedOrigins;
  return ok({
    status: "enabled",
    cdpEndpoints: parsedEndpoints.value,
    allowedOrigins: parsedOrigins.value,
  });
};

const parseElectronObservationPolicy = (
  env: Environment,
): Result<ElectronObservationPolicy, ConfigurationError> => {
  if (env.REA_ELECTRON_OBSERVE_ENABLED !== "true")
    return ok({ status: "disabled" });
  return ok({ status: "enabled" });
};

const parseV8InspectorObservationPolicy = (
  env: Environment,
): Result<V8InspectorObservationPolicy, ConfigurationError> => {
  if (env.REA_V8_INSPECTOR_OBSERVE_ENABLED !== "true")
    return ok({ status: "disabled" });
  return ok({ status: "enabled" });
};

const requireFirst = (
  values: readonly string[],
  message: string,
): Result<readonly [string, ...string[]], ConfigurationError> => {
  const [first, ...remaining] = values;
  return first === undefined
    ? err(new ConfigurationError(message))
    : ok([first, ...remaining]);
};

const appendBrowserCeiling = (
  ceilings: PermissionCeiling[],
  policy: BrowserObservationPolicy,
): void => {
  if (policy.status === "disabled") return;
  ceilings.push(
    permissionScope("browser_observe", [], {
      origins: [...policy.cdpEndpoints, ...policy.allowedOrigins],
      network: browserNetworkScope(policy.allowedOrigins),
    }),
  );
};

const appendElectronCeiling = (
  ceilings: PermissionCeiling[],
  policy: ElectronObservationPolicy,
): void => {
  if (policy.status === "disabled") return;
  ceilings.push(
    permissionScope("electron_observe", [], {
      network: "loopback",
    }),
  );
};

const appendV8InspectorCeiling = (
  ceilings: PermissionCeiling[],
  policy: V8InspectorObservationPolicy,
): void => {
  if (policy.status === "disabled") return;
  ceilings.push(
    permissionScope("v8_inspector_observe", [], {
      network: "loopback",
    }),
  );
};
