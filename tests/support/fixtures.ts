import { cliTest } from "./cli/cliFixture.js";
import {
  createTestLoopback,
  type TestLoopback,
} from "./network/loopbackFixture.js";
import { createTestMcp, type TestMcp } from "./mcp/mcpFixture.js";
import {
  createTestWorkspace,
  removeTestWorkspace,
  type TestWorkspace,
} from "./workspace/workspaceFixture.js";

const withWorkspace = cliTest.extend<{ workspace: TestWorkspace }>({
  // oxlint-disable-next-line no-empty-pattern -- Vitest parses fixture dependencies from object destructuring.
  workspace: async ({}, use) => {
    const workspace = await createTestWorkspace();
    try {
      await use(workspace);
    } finally {
      await removeTestWorkspace(workspace.root);
    }
  },
});

const withLoopback = withWorkspace.extend<{ loopback: TestLoopback }>({
  // oxlint-disable-next-line no-empty-pattern -- Vitest parses fixture dependencies from object destructuring.
  loopback: async ({}, use) => {
    const loopback = createTestLoopback();
    try {
      await use(loopback);
    } finally {
      await loopback.close();
    }
  },
});

/** Vitest API with all reusable, test-scoped REA resource fixtures. */
export const fixtureTest = withLoopback.extend<{ mcp: TestMcp }>({
  // oxlint-disable-next-line no-empty-pattern -- Vitest parses fixture dependencies from object destructuring.
  mcp: async ({}, use) => {
    const mcp = createTestMcp();
    try {
      await use(mcp);
    } finally {
      await mcp.close();
    }
  },
});

export type { CliInvocation, CliResult, TestCli } from "./cli/cliFixture.js";
export type {
  LoopbackEndpoint,
  TestLoopback,
} from "./network/loopbackFixture.js";
export type { McpClientIdentity, TestMcp } from "./mcp/mcpFixture.js";
export type {
  ProcessResult,
  ProcessRunOptions,
  TestProcesses,
} from "./process/processFixture.js";
export type { TestWorkspace } from "./workspace/workspaceFixture.js";
