import { describe, expect, it } from "vitest";

import { replayMachineSchema } from "./replayMachine.js";

const loginMachine = () => ({
  initial_state: "waiting_for_login",
  states: [
    { name: "waiting_for_login" },
    { name: "waiting_for_api" },
    { name: "complete", terminal: true },
  ],
  transitions: [
    {
      id: "login",
      from: "waiting_for_login",
      to: "waiting_for_api",
      priority: 10,
      trigger: { protocol: "http", method: "POST", path: "/login" },
      captures: [
        {
          variable: "token",
          value: { source: "request_json", path: ["token"] },
          sensitive: true,
        },
      ],
      actions: [{ type: "http_response", status: 204, headers: {}, body: "" }],
      max_uses: 1,
    },
    {
      id: "api",
      from: "waiting_for_api",
      to: "complete",
      priority: 10,
      trigger: { protocol: "http", method: "GET", path: "/api" },
      guards: [
        {
          variable: "token",
          value: { source: "request_header", name: "authorization" },
        },
      ],
      actions: [
        {
          type: "http_response",
          status: 200,
          headers: {},
          body: "done",
        },
      ],
      max_uses: 1,
    },
  ],
  max_transitions: 2,
});

describe("replay machine", () => {
  it("accepts a bounded, reachable, data-only login machine", () => {
    expect(replayMachineSchema.parse(loginMachine())).toMatchObject({
      initial_state: "waiting_for_login",
      max_transitions: 2,
    });
  });
});

describe("replay machine long identifiers", () => {
  it("accepts long state, transition, and variable identifiers", () => {
    const initialState = `s${"t".repeat(255)}`;
    const terminalState = `s${"f".repeat(255)}`;
    const transitionId = `t${"r".repeat(255)}`;
    const variable = `v${"a".repeat(255)}`;
    const machine = {
      initial_state: initialState,
      states: [{ name: initialState }, { name: terminalState, terminal: true }],
      transitions: [
        {
          id: transitionId,
          from: initialState,
          to: terminalState,
          trigger: { protocol: "http", method: "GET", path: "/complete" },
          captures: [
            {
              variable,
              value: { source: "request_header", name: "x-value" },
              sensitive: false,
            },
          ],
          actions: [{ type: "http_response", status: 200, body: "done" }],
          max_uses: 1,
        },
      ],
      max_transitions: 1,
    };

    expect(replayMachineSchema.parse(machine)).toMatchObject({
      initial_state: initialState,
      states: [{ name: initialState }, { name: terminalState }],
      transitions: [{ id: transitionId, captures: [{ variable }] }],
    });
  });
});

describe("replay machine long delays", () => {
  it("accepts replay delays longer than one operating-system timer", () => {
    const machine: unknown = {
      ...loginMachine(),
      transitions: loginMachine().transitions.map((transition, index) =>
        index === 0
          ? {
              ...transition,
              actions: [
                { type: "delay", duration_ms: 2_147_483_648 },
                ...transition.actions,
              ],
            }
          : transition,
      ),
    };

    expect(
      replayMachineSchema.parse(machine).transitions[0]?.actions[0],
    ).toEqual({ type: "delay", duration_ms: 2_147_483_648 });
  });
});

describe("replay machine validation", () => {
  it.each([
    [
      "unreachable state",
      (machine: ReturnType<typeof loginMachine>) =>
        machine.states.push({ name: "orphan", terminal: false }),
      "unreachable",
    ],
    [
      "ambiguous transition",
      (machine: ReturnType<typeof loginMachine>) => {
        const transition = machine.transitions[0];
        if (transition === undefined) throw new TypeError("missing transition");
        machine.transitions.push({ ...transition, id: "login_2" });
      },
      "ambiguous",
    ],
    [
      "outgoing terminal transition",
      (machine: ReturnType<typeof loginMachine>) => {
        const transition = machine.transitions[0];
        if (transition === undefined) throw new TypeError("missing transition");
        machine.transitions.push({
          ...transition,
          id: "restart",
          from: "complete",
          to: "waiting_for_login",
          trigger: { protocol: "http", method: "POST", path: "/restart" },
        });
      },
      "terminal",
    ],
    [
      "unknown guard variable",
      (machine: ReturnType<typeof loginMachine>) => {
        const guard = machine.transitions[1]?.guards?.[0];
        if (guard === undefined) throw new TypeError("missing guard");
        guard.variable = "missing";
      },
      "executable path before use",
    ],
    [
      "missing terminal state",
      (machine: ReturnType<typeof loginMachine>) => {
        const state = machine.states[2];
        if (state === undefined) throw new TypeError("missing state");
        state.terminal = false;
      },
      "terminal state",
    ],
  ])("rejects %s", (_name, mutate, message) => {
    const machine = loginMachine();
    mutate(machine);
    expect(() => replayMachineSchema.parse(machine)).toThrow(message);
  });

  it("canonicalizes methods and headers while refusing persisted credential matchers", () => {
    const canonical = {
      ...loginMachine(),
      transitions: loginMachine().transitions.map((transition, index) =>
        index === 0
          ? {
              ...transition,
              trigger: {
                protocol: "http",
                method: "post",
                path: "/login",
                headers: { "X-Request-ID": "fixture" },
              },
            }
          : transition,
      ),
    };
    expect(
      replayMachineSchema.parse(canonical).transitions[0]?.trigger,
    ).toMatchObject({
      method: "POST",
      headers: { "x-request-id": "fixture" },
    });
    const credentialMatcher = {
      ...loginMachine(),
      transitions: loginMachine().transitions.map((transition, index) =>
        index === 0
          ? {
              ...transition,
              trigger: {
                protocol: "http",
                method: "POST",
                path: "/login",
                headers: { Authorization: "test-auth-token" },
              },
            }
          : transition,
      ),
    };
    expect(() => replayMachineSchema.parse(credentialMatcher)).toThrow(
      /secret alias/u,
    );
  });
});

describe("replay machine validation", () => {
  it("rejects sensitive captures sourced from persisted action JSON", () => {
    const candidate = loginMachine();
    const capture = candidate.transitions[0]?.captures?.[0];
    if (capture === undefined) throw new TypeError("missing capture");
    capture.value = { source: "action_json", path: ["token"] };

    expect(() => replayMachineSchema.parse(candidate)).toThrow(
      /literal action JSON/u,
    );
  });

  it.each([
    ["invalid header name", { "bad header": "value" }],
    ["invalid header value", { "x-test": "value\nsmuggled" }],
  ])("rejects %s in HTTP responses", (_name, headers) => {
    const candidate = loginMachine();
    const action = candidate.transitions[0]?.actions[0];
    if (action === undefined || action.type !== "http_response")
      throw new TypeError("missing HTTP response");
    action.headers = headers;

    expect(() => replayMachineSchema.parse(candidate)).toThrow();
  });

  it("rejects unknown fields at nested machine boundaries", () => {
    const candidate = loginMachine();
    const action = candidate.transitions[0]?.actions[0];
    if (action === undefined) throw new TypeError("missing action");

    expect(() =>
      replayMachineSchema.parse({
        ...candidate,
        transitions: [
          {
            ...candidate.transitions[0],
            actions: [{ ...action, unexpected: true }],
          },
          candidate.transitions[1],
        ],
      }),
    ).toThrow(/Unrecognized key/u);
  });

  it("reports duplicate transition IDs as structured validation", () => {
    const candidate = loginMachine();
    const first = candidate.transitions[0];
    const second = candidate.transitions[1];
    if (first === undefined || second === undefined)
      throw new TypeError("missing transition");

    expect(
      replayMachineSchema.safeParse({
        ...candidate,
        transitions: [first, { ...second, id: first.id }],
      }),
    ).toMatchObject({ success: false });
  });

  it("rejects guards whose capture is not available before the transition", () => {
    const candidate = loginMachine();
    const first = candidate.transitions[0];
    if (first === undefined) throw new TypeError("missing transition");
    first.guards = [
      {
        variable: "token",
        value: { source: "request_header", name: "authorization" },
      },
    ];

    expect(() => replayMachineSchema.parse(candidate)).toThrow(
      /executable path before use/u,
    );
  });

  it("rejects ambiguous header triggers regardless of key order", () => {
    const candidate = loginMachine();
    const first = candidate.transitions[0];
    if (first === undefined) throw new TypeError("missing transition");
    const withHeaders = {
      ...first,
      trigger: {
        protocol: "http" as const,
        method: "POST",
        path: "/login",
        headers: { accept: "json", "x-mode": "test" },
      },
    };

    expect(() =>
      replayMachineSchema.parse({
        ...candidate,
        transitions: [
          withHeaders,
          {
            ...withHeaders,
            id: "login_duplicate",
            trigger: {
              ...withHeaders.trigger,
              headers: { "x-mode": "test", accept: "json" },
            },
          },
          candidate.transitions[1],
        ],
      }),
    ).toThrow(/ambiguous/u);
  });
});
