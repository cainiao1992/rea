import {
  ResourceNotFoundError,
  ResourceTemplate,
  type McpServer,
} from "@modelcontextprotocol/server";

import type { BinarySessionPort } from "../application/BinarySessionPort.js";
import { reconstructionReadinessReportSchema } from "../domain/reconstructionReadinessSchemas.js";

/** Expose retained full readiness reports outside compact tool responses. */
export const registerReconstructionReadinessResource = (
  server: McpServer,
  session: BinarySessionPort,
): void => {
  server.registerResource(
    "reconstruction-readiness-report",
    new ResourceTemplate(
      "rea://evidence/{evidenceId}/reconstruction-readiness-report",
      {
        list: undefined,
        complete: {
          evidenceId: (prefix) =>
            session
              .exportEvidenceBundle()
              .records.filter(
                ({ predicate_type: predicateType }) =>
                  predicateType === "rea.reconstruction-readiness-report/v1",
              )
              .map(({ evidence_id: evidenceId }) => evidenceId)
              .filter((evidenceId) => evidenceId.startsWith(prefix)),
        },
      },
    ),
    {
      title: "Reconstruction readiness report",
      description:
        "Full deterministic nine-stage conformance report and replay identity.",
      mimeType: "application/json",
    },
    (uri, variables) => {
      const evidenceId = variables.evidenceId;
      if (typeof evidenceId !== "string")
        throw new ResourceNotFoundError(uri.href);
      const evidence = session.evidenceById(evidenceId);
      if (
        evidence === undefined ||
        evidence.predicate_type !== "rea.reconstruction-readiness-report/v1"
      )
        throw new ResourceNotFoundError(uri.href);
      const report = reconstructionReadinessReportSchema.safeParse(
        evidence.normalized_result,
      );
      if (!report.success) throw new ResourceNotFoundError(uri.href);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(
              { evidence_id: evidence.evidence_id, report: report.data },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
};
