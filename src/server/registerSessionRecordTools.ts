import type { McpServer } from "@modelcontextprotocol/server";

import type { BinarySessionPort } from "../application/BinarySession.js";
import {
  readEvidenceBundle,
  writeEvidenceBundle,
} from "../application/EvidenceBundleFiles.js";
import type { PermissionAuthority } from "../application/PermissionAuthority.js";
import { SESSION_TOOL_CONTRACTS } from "../contracts/toolContracts.js";
import type { AnalysisError } from "../domain/errors.js";
import type {
  EvidenceBundle,
  EvidenceFilePolicy,
} from "../domain/evidenceBundle.js";
import { err, ok, type Result } from "../domain/result.js";
import { projectPermissionFailure } from "../application/PermissionFailure.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import { toCallToolResult } from "./toolResult.js";

interface EvidenceToolRegistration {
  readonly server: McpServer;
  readonly session: BinarySessionPort;
  readonly exportContract: (typeof SESSION_TOOL_CONTRACTS)[3];
  readonly importContract: (typeof SESSION_TOOL_CONTRACTS)[4];
  readonly snapshotContract: (typeof SESSION_TOOL_CONTRACTS)[19];
  readonly filePolicy: EvidenceFilePolicy;
  readonly permissionAuthority?: PermissionAuthority;
}

/** Register evidence bundle import and export tools. */
export const registerEvidenceTools = (
  registration: EvidenceToolRegistration,
): void => {
  registerExportEvidenceTool(registration);
  registerImportEvidenceTool(registration);
  registerSnapshotEvidenceTool(registration);
};

const registerExportEvidenceTool = ({
  server,
  session,
  exportContract,
  filePolicy,
  permissionAuthority,
}: EvidenceToolRegistration): void => {
  server.registerTool(
    exportContract.name,
    toolRegistrationOptions(exportContract),
    async (input) => {
      const bundle = session.exportEvidenceBundle();
      const denied = await authorizeEvidencePath({
        authority: permissionAuthority,
        capability: "evidence_write",
        path: input.path,
        access: "write",
        operationIdentity: `export_evidence:${input.path}`,
      });
      if (denied !== undefined) return toCallToolResult(denied, exportContract);
      const written = await writeEvidenceBundle(
        bundle,
        input.path,
        input.overwrite,
        filePolicy,
      );
      return written.ok
        ? toCallToolResult(
            ok({
              path: written.value.path,
              bytes: written.value.bytes,
              records: bundle.records.length,
              unknowns: bundle.unknowns.length,
            }),
            exportContract,
          )
        : toCallToolResult(written, exportContract);
    },
  );
};

const registerSnapshotEvidenceTool = ({
  server,
  session,
  snapshotContract,
}: EvidenceToolRegistration): void => {
  server.registerTool(
    snapshotContract.name,
    toolRegistrationOptions(snapshotContract),
    () =>
      toCallToolResult(ok(session.exportEvidenceBundle()), snapshotContract),
  );
};

const registerImportEvidenceTool = ({
  server,
  session,
  importContract,
  filePolicy,
  permissionAuthority,
}: EvidenceToolRegistration): void => {
  server.registerTool(
    importContract.name,
    toolRegistrationOptions(importContract),
    async (input) => {
      const path = input.path;
      const denied = await authorizeEvidencePath({
        authority: permissionAuthority,
        capability: "evidence_read",
        path,
        access: "read",
        operationIdentity: `import_evidence:${path}`,
      });
      if (denied !== undefined) return toCallToolResult(denied, importContract);
      const loaded = await readEvidenceBundle(path, filePolicy);
      if (!loaded.ok) return toCallToolResult(loaded, importContract);
      const retainedUnknownRevisions = new Set(
        session
          .exportEvidenceBundle()
          .unknowns.map((unknown) => unknownRevisionKey(unknown)),
      );
      const imported = session.importEvidenceBundle(loaded.value);
      return imported.ok
        ? toCallToolResult(
            ok({
              imported: imported.value,
              unknowns_added: loaded.value.unknowns.filter(
                (unknown) =>
                  !retainedUnknownRevisions.has(unknownRevisionKey(unknown)),
              ).length,
              total: session.exportEvidenceBundle().records.length,
            }),
            importContract,
          )
        : toCallToolResult(imported, importContract);
    },
  );
};

const unknownRevisionKey = (
  unknown: EvidenceBundle["unknowns"][number],
): string => `${unknown.unknown_id}:${String(unknown.revision)}`;

interface EvidenceAuthorizationInput {
  readonly authority: PermissionAuthority | undefined;
  readonly capability: "evidence_read" | "evidence_write";
  readonly path: string;
  readonly access: "read" | "write";
  readonly operationIdentity: string;
}

const authorizeEvidencePath = async (
  input: EvidenceAuthorizationInput,
): Promise<Result<never, AnalysisError> | undefined> => {
  if (input.authority === undefined) return undefined;
  const authorized = await input.authority.authorize(
    {
      capability: input.capability,
      roots: [input.path],
      executables: [],
      environment_names: [],
      network: "none",
      mount: false,
      operation_identity: input.operationIdentity,
    },
    input.access,
  );
  return authorized.ok
    ? undefined
    : err(projectPermissionFailure(authorized.error));
};

interface UnknownToolRegistration {
  readonly server: McpServer;
  readonly session: BinarySessionPort;
  readonly contracts: typeof SESSION_TOOL_CONTRACTS;
}

/** Register residual-unknown query and mutation tools. */
const registerListUnknownsTool = ({
  server,
  session,
  contracts,
}: UnknownToolRegistration): void => {
  const listContract = contracts[14];
  server.registerTool(
    listContract.name,
    toolRegistrationOptions(listContract),
    (input) => {
      const filters = input;
      const all = session.listUnknowns({
        ...(filters.status === undefined ? {} : { status: filters.status }),
        ...(filters.severity === undefined
          ? {}
          : { severity: filters.severity }),
        ...(filters.domain === undefined ? {} : { domain: filters.domain }),
      });
      return toCallToolResult(
        ok({
          items: all,
          total: all.length,
        }),
        listContract,
      );
    },
  );
};

const registerRecordUnknownTool = ({
  server,
  session,
  contracts,
}: UnknownToolRegistration): void => {
  const recordContract = contracts[15];
  server.registerTool(
    recordContract.name,
    toolRegistrationOptions(recordContract),
    (input) => {
      const result = session.recordUnknown(input);
      return toCallToolResult(result, recordContract);
    },
  );
};

const registerUpdateUnknownTool = ({
  server,
  session,
  contracts,
}: UnknownToolRegistration): void => {
  const updateContract = contracts[16];
  server.registerTool(
    updateContract.name,
    toolRegistrationOptions(updateContract),
    (input) => {
      const result = session.updateUnknown(input);
      return toCallToolResult(result, updateContract);
    },
  );
};

const registerVerifyUnknownTool = ({
  server,
  session,
  contracts,
}: UnknownToolRegistration): void => {
  const verifyContract = contracts[17];
  server.registerTool(
    verifyContract.name,
    toolRegistrationOptions(verifyContract),
    (input) =>
      toCallToolResult(
        session.verifyUnknownResolution(input.unknown_id),
        verifyContract,
      ),
  );
};

export const registerUnknownTools = (
  registration: UnknownToolRegistration,
): void => {
  registerListUnknownsTool(registration);
  registerRecordUnknownTool(registration);
  registerUpdateUnknownTool(registration);
  registerVerifyUnknownTool(registration);
};
