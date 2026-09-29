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
