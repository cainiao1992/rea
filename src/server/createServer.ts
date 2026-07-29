import { randomBytes } from "node:crypto";

import {
  CLIENT_CAPABILITIES_META_KEY,
  createRequestStateCodec,
  McpServer,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";

import type { AnalysisOperationPort } from "../application/AnalysisProvider.js";
import type { BinarySessionPort } from "../application/BinarySession.js";
import { PRODUCT_IDENTITY } from "../identity.js";
import { silentLogger, type Logger } from "../logger.js";
import type { ProcessExecutionPolicy } from "../domain/processCapture.js";
import type { EvidenceFilePolicy } from "../domain/evidenceBundle.js";
import { registerGuidedPrompts } from "./registerPrompts.js";
import { registerEvidenceResources } from "./registerEvidenceResources.js";
import type { PermissionAuthority } from "../application/PermissionAuthority.js";
import type { BrowserObservationPort } from "../application/BrowserObservationPort.js";
import type { BrowserScenarioCapturePort } from "../application/BrowserScenarioCapturePort.js";
import type { ElectronObservationPort } from "../application/ElectronObservationPort.js";
import type { JavaScriptRuntimeObservationPort } from "../application/JavaScriptRuntimeObservationPort.js";
import type { SessionAvailability } from "./sessionAvailabilityPolicy.js";
import { sessionAvailabilityPolicy } from "./sessionAvailabilityPolicy.js";
import {
  DENY_EVIDENCE_FILE_POLICY,
  DENY_PROCESS_POLICY,
} from "./sessionToolPolicies.js";
import { installDynamicToolAvailability } from "./DynamicToolAvailability.js";

const TARGET_FREE_INSTRUCTIONS =
  "ASAR/JavaScript -> analyze_javascript_application; archive/package -> open_binary(path), then inspect_artifact/inventory_artifact (active target); managed PE/CLI -> inspect_managed_artifact; passive browser/Electron -> list_browser_targets/list_electron_targets; approved browser interaction -> capture_browser_scenario; Node/Electron Inspector -> list_javascript_runtime_targets; native binary/database -> open_binary, then binary_overview. Start with binary_session; call only tools in tools/list. Hidden routes: binary_session detail=capabilities. Use summaries, cite Evidence IDs. Never repeat identical analysis or read full Evidence.";

const ACTIVE_TARGET_INSTRUCTIONS =
  "REA analyzes the active reverse-engineering target. Start native analysis with binary_overview, then narrow with analyze_function, literal search, callers, callees, and xrefs. Prefer summary views, never repeat an identical call, and read full Evidence only when the task requires it.";
import type {
  JavaScriptReplayHost,
  JavaScriptReplayPolicy,
  JavaScriptReplayRunner,
} from "../application/JavaScriptReplayPlanning.js";
import type { ManagedRuntimePolicy } from "../application/ManagedRuntimeCorrelationService.js";
import {
  PROCESS_CAPTURE_ELICITATION_POLICY,
  type ProcessCaptureElicitationState,
} from "./ProcessCaptureElicitation.js";
import { LazyToolCatalog } from "./LazyToolCatalog.js";

export interface CreateServerOptions {
  readonly logger?: Logger;
  readonly processPolicy?: ProcessExecutionPolicy;
  readonly evidenceFilePolicy?: EvidenceFilePolicy;
  readonly investigationInputRoots?: readonly string[];
  readonly analysisSnapshotFilePolicy?: EvidenceFilePolicy;
  readonly permissionAuthority?: PermissionAuthority;
  readonly browserObservation?: BrowserObservationPort;
  readonly browserScenarioCapture?: BrowserScenarioCapturePort;
  readonly electronObservation?: ElectronObservationPort;
  readonly javascriptRuntimeObservation?: JavaScriptRuntimeObservationPort;
  readonly artifactIntegrityContinueEnabled?: () => boolean;
  readonly javascriptReplayPolicy?: JavaScriptReplayPolicy;
  readonly javascriptReplayHost?: JavaScriptReplayHost;
  readonly javascriptReplayRunner?: JavaScriptReplayRunner;
  readonly managedRuntimePolicy?: ManagedRuntimePolicy;
  readonly availabilityPolicy?: () => SessionAvailability;
  readonly loadOptionalProviders?: () => Promise<{
    readonly browserObservation: BrowserObservationPort;
    readonly browserScenarioCapture: BrowserScenarioCapturePort;
    readonly electronObservation: ElectronObservationPort;
    readonly javascriptRuntimeObservation: JavaScriptRuntimeObservationPort;
  }>;
}

const installSessionToolAvailability = (
  server: McpServer,
  session: BinarySessionPort | undefined,
  options: CreateServerOptions,
) => {
  if (session === undefined) return undefined;
  const policy = sessionAvailabilityPolicy(options.availabilityPolicy, {
    processPolicy: options.processPolicy ?? DENY_PROCESS_POLICY,
    evidenceFilePolicy: options.evidenceFilePolicy ?? DENY_EVIDENCE_FILE_POLICY,
    investigationInputRoots: options.investigationInputRoots ?? [],
    optionalFeatures: {
      browserObservationEnabled: options.browserObservation !== undefined,
      browserScenarioEnabled: options.browserScenarioCapture !== undefined,
      electronObservationEnabled: options.electronObservation !== undefined,
      v8InspectorObservationEnabled:
        options.javascriptRuntimeObservation !== undefined,
      javascriptReplayEnabled: options.javascriptReplayPolicy?.enabled ?? false,
      managedRuntimeEnabled: options.managedRuntimePolicy?.enabled ?? false,
    },
  });
  return {
    policy,
    controller: installDynamicToolAvailability(server, session, policy),
  };
};

/**
 * Construct one MCP server without acquiring subprocess resources.
 * Supplying a session adds target lifecycle tools; omitting it retains the
 * fixed-target seam used by focused tests and embedders.
 */
export const createServer = (
  analysis: AnalysisOperationPort,
  session?: BinarySessionPort,
  options: CreateServerOptions = {},
): McpServer => {
  const startedAt = new Date().toISOString();
  const logger = options.logger ?? silentLogger;
  const permissionAuthority =
    options.permissionAuthority?.createConnectionAuthority();
  const processCaptureStateCodec =
    createRequestStateCodec<ProcessCaptureElicitationState>({
      key: randomBytes(32),
      ttlSeconds: PROCESS_CAPTURE_ELICITATION_POLICY.stateTtlSeconds,
    });
  const server = new McpServer(
    {
      name: PRODUCT_IDENTITY.mcpServerKey,
      version: PRODUCT_IDENTITY.packageVersion,
    },
    {
      capabilities: {
        tools: { listChanged: true },
        resources: { listChanged: true, subscribe: true },
      },
      inputRequired: {
        maxRounds: 3,
        roundTimeoutMs: PROCESS_CAPTURE_ELICITATION_POLICY.roundTimeoutMs,
      },
      requestState: { verify: processCaptureStateCodec.verify },
      instructions:
        session === undefined
          ? ACTIVE_TARGET_INSTRUCTIONS
          : TARGET_FREE_INSTRUCTIONS,
    },
  );
  const dynamicTools = installSessionToolAvailability(server, session, options);
  server.server.onclose = () => {
    permissionAuthority?.clearSessionGrants();
  };
  if (dynamicTools !== undefined)
    server.server.oninitialized = () => server.sendToolListChanged();
  session?.onAvailabilityChanged?.(() => server.sendToolListChanged());
  registerServerIdentityResource(server, startedAt);
  const toolLogger = logger.child({ layer: "server" });
  const { activeTarget, recordEvidence, recordEvidenceWithUnknown } =
    createSessionRecorders(server, session);
  const processCaptureElicitation = {
    stateCodec: processCaptureStateCodec,
    supported: (context: {
      readonly mcpReq: {
        readonly envelope?: Readonly<Record<string, unknown>>;
      };
    }) => {
      const envelope = context.mcpReq.envelope;
      const version = envelope?.[PROTOCOL_VERSION_META_KEY];
      const capabilities = envelope?.[CLIENT_CAPABILITIES_META_KEY];
      return (
        typeof version === "string" &&
        PROCESS_CAPTURE_ELICITATION_POLICY.protocolVersions.some(
          (supported) => supported === version,
        ) &&
        isRecord(capabilities) &&
        isRecord(capabilities.elicitation) &&
        capabilities.elicitation.form !== undefined
      );
    },
    now: Date.now,
    consumedNonces: new Map<string, number>(),
  };
  let optionalProviders:
    | ReturnType<NonNullable<CreateServerOptions["loadOptionalProviders"]>>
    | undefined;
  const loadOptionalProviders = () => {
    optionalProviders ??= options
      .loadOptionalProviders?.()
      .catch((cause: unknown) => {
        optionalProviders = undefined;
        throw cause;
      });
    return optionalProviders;
  };
  const lazyTools = new LazyToolCatalog(
    server,
    async (kind) => {
      const needsObservationProviders =
        kind === "browser-provider" ||
        kind === "electron-provider" ||
        kind === "runtime-provider";
      const [{ hydrateServerToolFamily }, loadedOptionalProviders] =
        await Promise.all([
          import("./hydrateServerTools.js"),
          needsObservationProviders ? loadOptionalProviders() : undefined,
        ]);
      const hydratedOptions =
        loadedOptionalProviders === undefined
          ? options
          : { ...options, ...loadedOptionalProviders };
      await hydrateServerToolFamily({
        kind,
        server,
        analysis,
        session,
        options: hydratedOptions,
        context: {
          logger: toolLogger,
          permissionAuthority,
          activeTarget,
          recordEvidence,
          recordEvidenceWithUnknown,
          availabilityPolicy: dynamicTools?.policy,
          startedAt,
          processCaptureElicitation,
        },
      });
    },
    session !== undefined,
  );
  lazyTools.register();
  registerGuidedPrompts(server, analysis, session);
  if (session !== undefined) {
    registerEvidenceResources(server, session);
  }
  dynamicTools?.controller.synchronize();
  const close = server.close.bind(server);
  server.close = async () => {
    await lazyTools.close();
    await close();
  };
  return server;
};

const createSessionRecorders = (
  server: McpServer,
  session: BinarySessionPort | undefined,
) => ({
  activeTarget:
    session === undefined ? undefined : () => session.activeTarget(),
  recordEvidence:
    session === undefined
      ? undefined
      : (evidence: Parameters<typeof session.recordEvidence>[0]) => {
          const recorded = session.recordEvidence(evidence);
          return recorded;
        },
  recordEvidenceWithUnknown:
    session === undefined
      ? undefined
      : (
          evidence: Parameters<typeof session.recordEvidenceWithUnknown>[0],
          input: Parameters<typeof session.recordEvidenceWithUnknown>[1],
        ) => {
          const recorded = session.recordEvidenceWithUnknown(evidence, input);
          return recorded;
        },
});

const registerServerIdentityResource = (
  server: McpServer,
  startedAt: string,
): void => {
  server.registerResource(
    "server-identity",
    "rea://server/identity",
    {
      title: "REA server identity",
      description: "Live package, SDK, protocol, and catalog identity.",
      mimeType: "application/json",
    },
    async (uri) => {
      const { createServerIdentity } = await import("../serverIdentity.js");
      const client = server.server.getClientVersion();
      const protocolVersion = server.server.getNegotiatedProtocolVersion();
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(
              createServerIdentity({
                startedAt,
                ...(client === undefined ? {} : { client }),
                ...(protocolVersion === undefined ? {} : { protocolVersion }),
              }),
              null,
              2,
            ),
          },
        ],
      };
    },
  );
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
