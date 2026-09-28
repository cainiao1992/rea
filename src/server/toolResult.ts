import type { CallToolResult } from "@modelcontextprotocol/server";

import type { ToolContract } from "../contracts/toolContracts.js";
import { projectAnalysisError, type AnalysisError } from "../domain/errors.js";
import type { JsonValue } from "../domain/jsonValue.js";
import type { Result } from "../domain/result.js";

/**
 * Translate an application result into MCP text content.
 * Error tags and safe messages remain visible while underlying causes, process
 * output, and other potentially sensitive details stay private.
 */
export const toCallToolResult = (
  result: Result<JsonValue, AnalysisError>,
  contract: ToolContract,
): CallToolResult =>
  result.ok ? successResult(result.value, contract) : errorResult(result.error);

const errorResult = (error: AnalysisError): CallToolResult => {
  const projected = projectAnalysisError(error);
  const structuredContent = { error: projected };
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(structuredContent),
      },
    ],
    structuredContent,
    isError: true,
  };
};

const successResult = (
  value: JsonValue,
  contract: ToolContract,
): CallToolResult => {
  const candidate =
    compactEvidence(value) ??
    (contract.kind === "session" ? { result: value } : value);
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(candidate),
      },
    ],
    structuredContent: candidate,
  };
};

const compactEvidence = (value: JsonValue): JsonValue | undefined => {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    typeof value.evidence_id !== "string" ||
    !/^ev_[a-f0-9]{64}$/u.test(value.evidence_id) ||
    !("normalized_result" in value)
  )
    return undefined;
  const evidence = value as Record<string, JsonValue>;
  const normalizedResult = evidence.normalized_result;
  const evidenceId = evidence.evidence_id;
  if (normalizedResult === undefined || typeof evidenceId !== "string")
    return undefined;
  const inlineEvidence = Object.fromEntries(
    Object.entries(evidence).filter(([key]) => key !== "normalized_result"),
  );
  return {
    result: normalizedResult,
    evidence_id: evidenceId,
    evidence: inlineEvidence,
  };
};
