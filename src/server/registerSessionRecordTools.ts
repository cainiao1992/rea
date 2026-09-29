import type { McpServer } from "@modelcontextprotocol/server";

import type { BinarySessionPort } from "../application/BinarySession.js";
import {
  readEvidenceBundle,
  writeEvidenceBundle,
} from "../application/EvidenceBundleFiles.js";
import { SESSION_TOOL_CONTRACTS } from "../contracts/toolContracts.js";
import type { EvidenceBundle } from "../domain/evidenceBundle.js";
import { ok } from "../domain/result.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import { toCallToolResult } from "./toolResult.js";

interface EvidenceToolRegistration {
  readonly server: McpServer;
  readonly session: BinarySessionPort;
  readonly exportContract: (typeof SESSION_TOOL_CONTRACTS)[3];
  readonly importContract: (typeof SESSION_TOOL_CONTRACTS)[4];
  readonly snapshotContract: (typeof SESSION_TOOL_CONTRACTS)[19];
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
}: EvidenceToolRegistration): void => {
  server.registerTool(
    exportContract.name,
    toolRegistrationOptions(exportContract),
    async (input) => {
      const bundle = session.exportEvidenceBundle();
      const written = await writeEvidenceBundle(
        bundle,
        input.path,
        input.overwrite,
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
}: EvidenceToolRegistration): void => {
  server.registerTool(
    importContract.name,
    toolRegistrationOptions(importContract),
    async (input) => {
      const path = input.path;
      const loaded = await readEvidenceBundle(path);
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
