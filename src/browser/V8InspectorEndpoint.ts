import { z } from "zod";

import type {
  JavaScriptRuntimeTargetList,
  JavaScriptRuntimeLocation,
} from "../domain/javascriptRuntimeObservation.js";
import {
  BrowserObservationError,
  type BrowserObservationOperation,
} from "../domain/errors.js";
import { readBoundedCdpJson } from "./CdpEndpoint.js";

const MAX_VERSION_BYTES = 64 * 1_024;
const MAX_TARGET_LIST_BYTES = 2 * 1_024 * 1_024;

const versionSchema = z
  .object({
    Browser: z.string().min(1).max(1_024),
    "Protocol-Version": z.string().min(1).max(100),
    "V8-Version": z.string().max(1_024).optional(),
  })
  .passthrough();

const targetSchema = z
  .object({
    id: z.string().min(1).max(256),
    type: z.string().min(1).max(100),
    url: z.string().max(65_536),
    attached: z.boolean().default(false),
    webSocketDebuggerUrl: z.string().min(1).max(2_048),
  })
  .passthrough();
const targetsSchema = z.array(targetSchema).max(1_000);

export interface V8InspectorTarget {
  readonly id: string;
  readonly type: string;
  readonly url: string;
  readonly attached: boolean;
  readonly webSocketUrl: string;
}

export interface V8InspectorDiscovery {
  readonly runtime: JavaScriptRuntimeTargetList["runtime"];
  readonly targets: readonly V8InspectorTarget[];
}

/** Discover bounded Node/Electron Inspector targets from one loopback endpoint. */
export const discoverV8Inspector = async (
  endpoint: string,
  operation: BrowserObservationOperation,
  signal?: AbortSignal,
): Promise<V8InspectorDiscovery> => {
  const [versionInput, targetsInput] = await Promise.all([
    readBoundedCdpJson(
      new URL("/json/version", endpoint),
      MAX_VERSION_BYTES,
      operation,
      signal,
    ),
    readBoundedCdpJson(
      new URL("/json/list", endpoint),
      MAX_TARGET_LIST_BYTES,
      operation,
      signal,
    ),
  ]);
  const version = parse(versionSchema, versionInput, operation);
  const targets = parse(targetsSchema, targetsInput, operation);
  return {
    runtime: {
      product: version.Browser,
      protocol_version: version["Protocol-Version"],
      v8_version: version["V8-Version"] ?? null,
    },
    targets: targets.map((target) => ({
      id: target.id,
      type: target.type,
      url: target.url,
      attached: target.attached,
      webSocketUrl: validatedInspectorWebSocket(
        endpoint,
        target.id,
        target.webSocketDebuggerUrl,
        operation,
      ),
    })),
  };
};

const parse = <Output>(
  schema: z.ZodType<Output>,
  input: unknown,
  operation: BrowserObservationOperation,
): Output => {
  const parsed = schema.safeParse(input);
  if (!parsed.success)
    throw new BrowserObservationError(operation, "invalid_endpoint_response", {
      cause: parsed.error,
    });
  return parsed.data;
};

const validatedInspectorWebSocket = (
  endpoint: string,
  targetId: string,
  reported: string,
  operation: BrowserObservationOperation,
): string => {
  let socket: URL;
  try {
    socket = new URL(reported);
  } catch (cause: unknown) {
    throw new BrowserObservationError(operation, "invalid_endpoint_response", {
      cause,
    });
  }
  const trusted = new URL(endpoint);
  const allowedPaths = new Set([
    `/${targetId}`,
    `/devtools/node/${targetId}`,
    `/devtools/page/${targetId}`,
  ]);
  if (
    socket.protocol !== "ws:" ||
    socket.port !== trusted.port ||
    socket.username !== "" ||
    socket.password !== "" ||
    socket.search !== "" ||
    socket.hash !== "" ||
    !allowedPaths.has(socket.pathname)
  )
    throw new BrowserObservationError(operation, "invalid_endpoint_response");
  socket.hostname = trusted.hostname;
  return socket.href;
};

/** Authorized target plus its durable location. */
export interface AuthorizedV8InspectorTarget extends V8InspectorTarget {
  readonly location: JavaScriptRuntimeLocation;
}
