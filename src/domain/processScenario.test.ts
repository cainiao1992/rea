import { describe, expect, it } from "vitest";

import { processScenarioSchema } from "./processScenario.js";

describe("process scenario collection inputs", () => {
  it("accepts more than 64 named filesystem checkpoints", () => {
    const scenario = processScenarioSchema.parse({
      executable: "/bin/echo",
      working_directory: "/tmp",
      checkpoints: Array.from({ length: 65 }, (_, index) => ({
        name: `state-${index}`,
        trigger: { type: "root_exit" as const },
      })),
    });

    expect(scenario.checkpoints).toHaveLength(65);
  });

  it("allows a zero-depth filesystem observation", () => {
    expect(
      processScenarioSchema.parse({
        executable: "/bin/echo",
        working_directory: "/tmp",
        limits: { filesystem_depth: 0 },
      }).limits.filesystem_depth,
    ).toBe(0);
  });

  it("accepts caller budgets above the former tool-side ceilings", () => {
    const scenario = processScenarioSchema.parse({
      executable: "/bin/echo",
      working_directory: "/tmp",
      timeout_ms: 600_000,
      idle_timeout_ms: 900_000,
      settle_ms: 20_000,
      limits: {
        output_bytes: 10_000_001,
        files: 100_001,
        file_bytes: 100_000_001,
        processes: 10_001,
        protocol_events: 100_001,
        protocol_body_bytes: 10_000_001,
        connections: 1_001,
        filesystem_depth: 100,
      },
      checkpoints: [
        {
          name: "later",
          trigger: { type: "time", at_ms: 600_000 },
        },
      ],
    });

    expect(scenario.limits.output_bytes).toBe(10_000_001);
    expect(scenario.limits.files).toBe(100_001);
    expect(scenario.limits.file_bytes).toBe(100_000_001);
    expect(scenario.limits.processes).toBe(10_001);
    expect(scenario.limits.protocol_events).toBe(100_001);
    expect(scenario.limits.protocol_body_bytes).toBe(10_000_001);
    expect(scenario.limits.connections).toBe(1_001);
    expect(scenario.limits.filesystem_depth).toBe(100);
    expect(scenario.timeout_ms).toBe(600_000);
    expect(scenario.idle_timeout_ms).toBe(900_000);
    expect(scenario.settle_ms).toBe(20_000);
  });

  it("accepts large interaction and replay descriptions under the run budgets", () => {
    const environment = Object.fromEntries(
      Array.from({ length: 65 }, (_, index) => [`APP_VALUE_${index}`, "x"]),
    );
    const commandShims = Array.from({ length: 33 }, (_, shimIndex) => ({
      name: `tool-${shimIndex}`,
      routes: Array.from({ length: 101 }, (_, routeIndex) => ({
        arguments: [`--route-${routeIndex}`],
        outputs: Array.from({ length: routeIndex === 0 ? 1_001 : 0 }, () => ({
          at_ms: 0,
          stream: "stdout" as const,
          data: "x",
        })),
        termination: { type: "exit" as const, code: 0 },
        max_calls: 101,
      })),
    }));
    const scenario = processScenarioSchema.parse({
      executable: "/bin/echo",
      arguments: Array.from({ length: 257 }, (_, index) => String(index)),
      working_directory: "/tmp",
      filesystem_roots: Array.from(
        { length: 17 },
        (_, index) => `/tmp/root-${index}`,
      ),
      environment,
      inherit_environment: Array.from(
        { length: 65 },
        (_, index) => `INHERITED_${index}`,
      ),
      secret_aliases: Object.keys(environment),
      command_shims: commandShims,
      events: Array.from({ length: 1_001 }, () => ({
        type: "input" as const,
        at_ms: 0,
        data: "x",
      })),
      checkpoints: [
        {
          name: "many_occurrences",
          trigger: {
            type: "terminal_literal",
            value: "ready",
            occurrence: 1_001,
          },
        },
      ],
      replay: {
        http: Array.from({ length: 101 }, (_, index) => ({
          method: "GET",
          path: `/route-${index}`,
          status: 200,
          body: "ok",
          max_calls: 101,
        })),
        websocket_messages: Array.from({ length: 101 }, () => "message"),
        websocket_connections: Array.from({ length: 101 }, () => ({
          messages: Array.from({ length: 101 }, () => ({ data: "message" })),
          disconnect_after: false,
        })),
      },
    });

    expect(scenario.arguments).toHaveLength(257);
    expect(scenario.inherit_environment).toHaveLength(65);
    expect(scenario.command_shims).toHaveLength(33);
    expect(scenario.command_shims[0]?.routes).toHaveLength(101);
    expect(scenario.command_shims[0]?.routes[0]?.outputs).toHaveLength(1_001);
    expect(scenario.events).toHaveLength(1_001);
    expect(scenario.filesystem_roots).toHaveLength(17);
    expect(scenario.checkpoints[0]?.trigger).toMatchObject({
      occurrence: 1_001,
    });
    expect(scenario.replay.http).toHaveLength(101);
    expect(scenario.replay.websocket_connections[0]?.messages).toHaveLength(
      101,
    );
  });
});
