import { describe, expect, it } from "vitest";

import { replayMachineSchema } from "./replayMachine.js";

const websocketActions = (count: number) =>
  Array.from({ length: count }, () => ({
    type: "websocket_send" as const,
    data: "ok",
  }));

const websocketMachine = () => ({
  initial_state: "start",
  states: [
    { name: "start" },
    { name: "active", max_visits: 100_001 },
    { name: "done", terminal: true },
  ],
  transitions: [
    {
      id: "begin",
      from: "start",
      to: "active",
      trigger: { protocol: "websocket_connect", path: "/begin" },
      actions: websocketActions(1),
      max_uses: 10_001,
    },
    {
      id: "finish",
      from: "active",
      to: "done",
      trigger: { protocol: "websocket_message", path: "/finish" },
      actions: websocketActions(1),
      max_uses: 10_001,
    },
  ],
  max_transitions: 100_001,
  limits: {
    connections: 1_001,
    messages: 100_001,
    bytes: 10_000_001,
    duration_ms: 300_001,
  },
});

describe("finite replay machine schema input size", () => {
  it("accepts states, transitions, guards, captures, actions, and paths beyond old caps", () => {
    const states: { name: string; terminal?: boolean }[] = Array.from(
      { length: 257 },
      (_, index) => ({
        name: `state-${index}`,
      }),
    );
    states.push({ name: "complete", terminal: true });
    const transitions = Array.from({ length: 257 }, (_, index) => ({
      id: `chain-${index}`,
      from: `state-${index}`,
      to: index === 256 ? "complete" : `state-${index + 1}`,
      trigger: { protocol: "http", method: "GET", path: `/chain-${index}` },
      actions: [{ type: "http_response", status: 200, body: "" }],
      max_uses: 10_001,
    }));
    transitions.push(
      ...Array.from({ length: 1_745 }, (_, index) => ({
        id: `loop-${index}`,
        from: "state-0",
        to: "state-0",
        trigger: { protocol: "http", method: "GET", path: `/loop-${index}` },
        actions: [{ type: "http_response", status: 200, body: "" }],
        max_uses: 10_001,
      })),
    );

    const parsed = replayMachineSchema.safeParse({
      initial_state: "state-0",
      states,
      transitions,
      max_transitions: 100_001,
      limits: {
        connections: 1_001,
        messages: 100_001,
        bytes: 10_000_001,
        duration_ms: 300_001,
      },
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.states).toHaveLength(258);
      expect(parsed.data.transitions).toHaveLength(2_002);
    }
  });

  it("accepts over 32 guards, captures, actions, and path segments", () => {
    const path = Array.from({ length: 33 }, (_, index) => `key-${index}`);
    const input = websocketMachine();
    const machine = {
      ...input,
      transitions: [
        {
          id: "capture",
          from: "start",
          to: "active",
          trigger: { protocol: "websocket_connect", path: "/begin" },
          captures: Array.from({ length: 33 }, () => ({
            variable: "value",
            value: { source: "request_json", path },
            sensitive: false,
          })),
          actions: websocketActions(33),
          max_uses: 10_001,
        },
        {
          id: "guarded-finish",
          from: "active",
          to: "done",
          trigger: { protocol: "websocket_message", path: "/finish" },
          guards: Array.from({ length: 33 }, () => ({
            variable: "value",
            value: { source: "request_json", path },
          })),
          actions: websocketActions(33),
          max_uses: 10_001,
        },
      ],
    };

    expect(replayMachineSchema.safeParse(machine).success).toBe(true);
  });
});
