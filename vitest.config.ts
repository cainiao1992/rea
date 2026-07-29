import { realpathSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";

import { defineConfig } from "vitest/config";

const CANONICAL_TEMPORARY_DIRECTORY = realpathSync(tmpdir());
const COVERAGE_ENABLED = process.argv.some((argument) =>
  argument.startsWith("--coverage"),
);
export const MAX_TEST_WORKERS = Math.min(4, availableParallelism());

export const TEST_PROJECTS = [
  {
    name: "domain",
    include: ["src/domain/**/*.test.ts"],
    pool: "threads" as const,
    maxWorkers: MAX_TEST_WORKERS,
  },
  {
    name: "services",
    include: ["src/application/**/*.test.ts"],
    pool: "threads" as const,
    maxWorkers: MAX_TEST_WORKERS,
  },
  {
    name: "adapters",
    include: [
      "src/{artifacts,browser,dotnet,ghidra,hopper,native,process,reference,replay}/**/*.test.ts",
    ],
    pool: "forks" as const,
    maxWorkers: MAX_TEST_WORKERS,
  },
  {
    name: "composition",
    include: ["tests/composition/**/*.test.ts"],
    pool: "threads" as const,
    maxWorkers: MAX_TEST_WORKERS,
  },
  {
    name: "boundary",
    include: ["tests/boundary/**/*.test.ts"],
    pool: "forks" as const,
    maxWorkers: MAX_TEST_WORKERS,
  },
  {
    name: "acceptance",
    include: ["tests/acceptance/**/*.test.ts"],
    pool: "forks" as const,
    maxWorkers: 1,
  },
  {
    name: "process-global",
    include: ["tests/process-global/**/*.test.ts"],
    pool: "forks" as const,
    fileParallelism: false,
  },
  {
    name: "conformance",
    include: ["tests/conformance/**/*.test.ts"],
    pool: "threads" as const,
    maxWorkers: MAX_TEST_WORKERS,
  },
  {
    name: "evaluation",
    include: ["tests/evaluation/**/*.test.ts"],
    pool: "threads" as const,
    maxWorkers: MAX_TEST_WORKERS,
  },
];

const projects = TEST_PROJECTS.map((project) => ({
  extends: true as const,
  test: project,
}));

export default defineConfig({
  test: {
    env: { TMPDIR: CANONICAL_TEMPORARY_DIRECTORY },
    maxWorkers: MAX_TEST_WORKERS,
    projects,
    retry: 0,
    reporters: ["default"],
    // Boundary projects may compete with TypeScript, docs, and package checks
    // under Turbo. Keep the deadline bounded while avoiding false failures from
    // host-level CPU and filesystem contention.
    testTimeout: COVERAGE_ENABLED ? 30_000 : 15_000,
    coverage: {
      enabled: false,
      provider: "v8",
      reportsDirectory: join(
        tmpdir(),
        `rea-vitest-coverage-${String(process.pid)}`,
      ),
      include: ["src/**"],
      thresholds: {
        statements: 65,
        branches: 60,
        functions: 60,
        lines: 68,
        "src/domain/**": {
          statements: 80,
          branches: 75,
          functions: 75,
          lines: 80,
        },
        "src/contracts/**": {
          statements: 85,
          branches: 80,
          functions: 80,
          lines: 85,
        },
      },
      reporter: ["text", "text-summary"],
    },
  },
});
