import type { AnalysisProviderSelector } from "./contracts/providerSelection.js";
import {
  DEFAULT_MCP_DOCTOR_DEADLINE_MS,
  DEFAULT_MCP_FIRST_CATALOG_BUDGET_MS,
  DEFAULT_MCP_INITIALIZE_BUDGET_MS,
  DEFAULT_MCP_TOOLS_LIST_BUDGET_MS,
  mcpPhaseBudgetRecovery,
  resolveMcpStartupBudgets,
  type McpPhaseBudget,
  type McpStartupBudgets,
} from "./config/mcpStartupBudgets.js";

/**
 * Supported MCP startup deadlines and operation headroom.
 *
 * Client timeouts are caller-facing configuration. The phase budgets below
 * are the unset defaults of `REA_MCP_INITIALIZE_BUDGET_MS`,
 * `REA_MCP_TOOLS_LIST_BUDGET_MS`, `REA_MCP_FIRST_CATALOG_BUDGET_MS`, and
 * `REA_MCP_DOCTOR_DEADLINE_MS`. Callers that enforce a phase read
 * `resolveMcpStartupProbePolicy` so a selected value is not ignored.
 * `codexStartupTimeoutSeconds` stays client guidance and is not a setting.
 */
export const MCP_STARTUP_POLICY = {
  codexStartupTimeoutSeconds: 30,
  kimiStartupTimeoutMs: 30_000,
  toolOperationHeadroomMs: 120_000,
  initializeBudgetMs: DEFAULT_MCP_INITIALIZE_BUDGET_MS,
  toolsListBudgetMs: DEFAULT_MCP_TOOLS_LIST_BUDGET_MS,
  firstCatalogBudgetMs: DEFAULT_MCP_FIRST_CATALOG_BUDGET_MS,
  doctorDeadlineMs: DEFAULT_MCP_DOCTOR_DEADLINE_MS,
  doctorStderrBytes: 64 * 1024,
} as const;

/** Phase budgets the packaged startup probe enforces. */
export type McpStartupProbePolicy = McpStartupBudgets;

/**
 * Resolve the probe policy from the environment that starts the probe.
 * An invalid phase setting is refused. Codex's 30 second startup figure
 * is not part of this policy.
 */
export const resolveMcpStartupProbePolicy = (
  environment: Readonly<Record<string, string | undefined>>,
): McpStartupProbePolicy => resolveMcpStartupBudgets(environment);

/** Doctor startup recovery. The Codex figure is client guidance REA does not enforce. */
export const mcpDoctorDeadlineRecovery = (budget: McpPhaseBudget): string =>
  `${mcpPhaseBudgetRecovery(budget)} Codex startup_timeout_sec of ${String(MCP_STARTUP_POLICY.codexStartupTimeoutSeconds)} seconds is client guidance; REA does not enforce that figure as this deadline.`;

/** Parsed startup and upstream request budgets affecting a client's tool deadline. */
export interface McpToolTimeoutInputs {
  readonly analysisProvider: AnalysisProviderSelector;
  readonly ghidraStartupTimeoutMs: number;
  readonly hopperStartupTimeoutMs: number;
  readonly jebMcpTimeoutMs?: number;
  readonly providerRequestTimeoutMs?: number;
}

/** Allow for known startup phases and caller-selected upstream request budgets. */
export const mcpProviderDeadlineAllowanceMs = (
  inputs: McpToolTimeoutInputs,
): number => {
  const selectedProvider = inputs.analysisProvider;
  const selectedTimeout =
    selectedProvider === "ghidra"
      ? inputs.ghidraStartupTimeoutMs
      : selectedProvider === "hopper"
        ? inputs.hopperStartupTimeoutMs
        : Math.max(
            inputs.ghidraStartupTimeoutMs,
            inputs.hopperStartupTimeoutMs,
          );
  return Math.max(
    selectedTimeout,
    inputs.jebMcpTimeoutMs ?? 0,
    inputs.providerRequestTimeoutMs ?? 0,
  );
};

/** Add operation headroom to the parsed provider deadline allowance. */
export const recommendedMcpToolTimeoutMs = (
  inputs: McpToolTimeoutInputs,
): number =>
  mcpProviderDeadlineAllowanceMs(inputs) +
  MCP_STARTUP_POLICY.toolOperationHeadroomMs;

/** Round up so Codex's whole-second deadline still covers the millisecond budget. */
export const recommendedMcpToolTimeoutSeconds = (
  inputs: McpToolTimeoutInputs,
): number => Math.ceil(recommendedMcpToolTimeoutMs(inputs) / 1000);
