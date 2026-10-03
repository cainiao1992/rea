import {
  finish,
  observation,
  offer,
  scenarioWith,
  succeededEffect,
  terminalTrigger,
} from "./processReactiveRuntime.fixture.js";
import {
  commitProcessReactiveProposal,
  createProcessReactiveSnapshot,
  reduceProcessReactiveScenario,
} from "./processReactiveRuntime.js";
import { processReactiveScenarioSchema } from "./processReactiveScenario.js";
import { describe, expect, it } from "vitest";

describe("process reactive runtime: terminal text matching", () => {
  it("matches decoded terminal text across PTY chunks and emits declarative effects", () => {
    const scenario = scenarioWith([
      finish("ready", terminalTrigger(), 100, [
        { type: "send_signal", target: { kind: "root" }, signal: "SIGINT" },
        { type: "checkpoint", name: "ready" },
      ]),
    ]);
    const first = offer(
      scenario,
      createProcessReactiveSnapshot(scenario),
      observation("terminal_raw", 0, {
        sequence: 0,
        at_ms: 0,
        data: "Re",
      }),
    );
    expect(first.kind).toBe("waiting");
    const second = offer(
      scenario,
      first.snapshot,
      observation("terminal_raw", 1, {
        sequence: 1,
        at_ms: 1,
        data: "ady\n",
      }),
    );
    expect(second.kind).toBe("transition");
    if (second.kind !== "transition") return;
    expect(second.record).toEqual({
      sequence: 0,
      transition_id: "ready",
      state_before: "starting",
      state_after: null,
      outcome: "passed",
      trigger_event_ids: ["obs.frames.0", "obs.frames.1"],
      action_event_ids: [
        "obs.interaction_events.2",
        "obs.filesystem_checkpoints.3",
      ],
      action_types: ["send_signal", "checkpoint"],
    });
  });
  it("treats redaction-shaped live input as ordinary sensitive data", () => {
    const scenario = scenarioWith([
      finish("ready", terminalTrigger(), 100, [
        {
          type: "send_input",
          data: "<redacted-input:1-bytes>",
          sensitive: true,
        },
      ]),
    ]);
    const decision = offer(
      scenario,
      createProcessReactiveSnapshot(scenario),
      observation("terminal_raw", 0, { data: "Ready" }),
    );
    expect(decision).toMatchObject({
      kind: "transition",
      record: { outcome: "passed" },
    });
  });
  it("reports only the minimal terminal chunk span containing the occurrence", () => {
    const scenario = scenarioWith([finish("ready", terminalTrigger())]);
    let snapshot = createProcessReactiveSnapshot(scenario);
    for (const [order, data] of ["unrelated\n", "Re"].entries()) {
      const decision = offer(
        scenario,
        snapshot,
        observation("terminal_raw", order, { data }),
      );
      expect(decision.kind).toBe("waiting");
      snapshot = decision.snapshot;
    }
    const matched = offer(
      scenario,
      snapshot,
      observation("terminal_raw", 2, { data: "ady" }),
    );
    expect(matched.kind).toBe("transition");
    if (matched.kind === "transition")
      expect(matched.record.trigger_event_ids).toEqual([
        "obs.frames.1",
        "obs.frames.2",
      ]);
  });
});

describe("process reactive runtime: observation retention", () => {
  it("matches terminal text after the previous retained-data ceiling", () => {
    const scenario = scenarioWith([finish("large_output", terminalTrigger())]);
    const decision = reduceProcessReactiveScenario(
      scenario,
      createProcessReactiveSnapshot(scenario),
      {
        kind: "observation",
        observation: observation("terminal_raw", 0, {
          data: `${"x".repeat(70_000)}Ready`,
        }),
      },
    );
    expect(decision.kind).toBe("proposal");
  });

  it("evaluates all configured predicates against all retained observations", () => {
    const transitions = Array.from({ length: 80 }, (_, index) =>
      finish(`event_${String(index)}`, {
        kind: "event",
        source: "shim",
        exact: { name: `expected_${String(index)}` },
        ignore_fields: ["sequence"],
        since: { kind: "scenario_start" },
        consume: false,
        cardinality: { min: 1, max: 1 },
      }),
    );
    const scenario = scenarioWith(transitions);
    const retained = Array.from({ length: 130 }, (_, order) =>
      observation("shim", order, { name: "other", sequence: order }),
    );
    const snapshot = {
      ...createProcessReactiveSnapshot(scenario),
      observations: retained,
    };
    const decision = offer(
      scenario,
      snapshot,
      observation("shim", retained.length, {
        name: "other",
        sequence: retained.length,
      }),
    );
    expect(decision).toMatchObject({ kind: "waiting" });
    if (decision.kind === "waiting")
      expect(decision.snapshot.observations).toHaveLength(131);
  });
});

describe("process reactive runtime: effect commit ordering", () => {
  it("does not commit state, checkpoints, consumption, or history before effects succeed", () => {
    const scenario = scenarioWith([
      finish("ready", { ...terminalTrigger(), consume: true }, 100, [
        { type: "checkpoint", name: "ready" },
        { type: "send_signal", target: { kind: "root" }, signal: "SIGINT" },
      ]),
    ]);
    const proposed = reduceProcessReactiveScenario(
      scenario,
      createProcessReactiveSnapshot(scenario),
      {
        kind: "observation",
        observation: observation("terminal_raw", 0, { data: "Ready" }),
      },
    );
    expect(proposed.kind).toBe("proposal");
    if (proposed.kind !== "proposal") return;
    expect(proposed.snapshot).toMatchObject({
      status: "running",
      checkpoints: [],
      consumed_event_ids: [],
      transitions: [],
    });
    const rejected = commitProcessReactiveProposal(scenario, proposed, [
      {
        status: "succeeded",
        observation: observation("filesystem", 1, { name: "ready" }),
      },
      { status: "rejected" },
    ]);
    expect(rejected).toMatchObject({
      kind: "finished",
      outcome: "action_rejected",
      snapshot: {
        checkpoints: [],
        consumed_event_ids: [],
        transitions: [],
      },
    });
    expect(
      commitProcessReactiveProposal(scenario, proposed, [
        { status: "target_lost" },
        {
          status: "succeeded",
          observation: observation("interaction", 2, {
            type: "signal",
            data: "SIGINT",
            outcome: "dispatched",
          }),
        },
      ]),
    ).toMatchObject({ kind: "finished", outcome: "target_lost" });
    const committed = commitProcessReactiveProposal(scenario, proposed, [
      {
        status: "succeeded",
        observation: observation("filesystem", 1, { name: "ready" }),
      },
      {
        status: "succeeded",
        observation: observation("interaction", 2, {
          type: "signal",
          data: "SIGINT",
          outcome: "dispatched",
        }),
      },
    ]);
    expect(committed.snapshot).toMatchObject({
      checkpoints: [
        {
          name: "ready",
          event_id: "obs.filesystem_checkpoints.1",
          capture_order: 1,
        },
      ],
    });
    expect(
      commitProcessReactiveProposal(scenario, proposed, [
        {
          status: "succeeded",
          observation: observation("filesystem", 1, { name: "other" }),
        },
        {
          status: "succeeded",
          observation: observation("interaction", 2, {
            type: "signal",
            data: "SIGINT",
            outcome: "dispatched",
          }),
        },
      ]),
    ).toMatchObject({ kind: "finished", outcome: "action_rejected" });
    const changedScenario = scenarioWith([
      finish("ready", { ...terminalTrigger(), consume: true }, 100, [
        { type: "checkpoint", name: "changed" },
        { type: "send_signal", target: { kind: "root" }, signal: "SIGINT" },
      ]),
    ]);
    expect(
      commitProcessReactiveProposal(changedScenario, proposed, [
        succeededEffect({ type: "checkpoint", name: "ready" }, 1),
        succeededEffect(
          {
            type: "send_signal",
            target: { kind: "root" },
            signal: "SIGINT",
          },
          2,
        ),
      ]),
    ).toMatchObject({ kind: "finished", outcome: "target_lost" });
    expect(
      commitProcessReactiveProposal(scenario, proposed, [
        {
          status: "succeeded",
          observation: observation("filesystem", 1, { name: "ready" }),
        },
        {
          status: "succeeded",
          observation: {
            ...observation("filesystem", 2, { name: "ready" }),
            event_id: "obs.filesystem_checkpoints.1",
          },
        },
      ]),
    ).toMatchObject({ kind: "finished", outcome: "action_rejected" });
  });
});

describe("process reactive runtime: predicate selection", () => {
  it("selects a unique priority and reports equal-priority ambiguity", () => {
    const preferred = scenarioWith([
      finish("fallback", terminalTrigger(), 20),
      finish("preferred", terminalTrigger(), 10),
    ]);
    const selected = offer(
      preferred,
      createProcessReactiveSnapshot(preferred),
      observation("terminal_raw", 0, { data: "Ready" }),
    );
    expect(selected.kind).toBe("transition");
    if (selected.kind === "transition")
      expect(selected.record.transition_id).toBe("preferred");
    for (const transitions of [
      [finish("one", terminalTrigger()), finish("two", terminalTrigger())],
      [finish("two", terminalTrigger()), finish("one", terminalTrigger())],
    ]) {
      const ambiguous = scenarioWith(transitions);
      const decision = offer(
        ambiguous,
        createProcessReactiveSnapshot(ambiguous),
        observation("terminal_raw", 0, { data: "Ready" }),
      );
      expect(decision).toMatchObject({
        kind: "finished",
        outcome: "ambiguous_match",
      });
    }
  });
  it("matches caller supplied terminal literals longer than the former schema cap", () => {
    const literal = "Ready".repeat(2_001);
    const scenario = scenarioWith([
      finish("long_literal", terminalTrigger(literal)),
    ]);
    const decision = offer(
      scenario,
      createProcessReactiveSnapshot(scenario),
      observation("terminal_raw", 0, { data: `prefix${literal}suffix` }),
    );

    expect(decision).toMatchObject({
      kind: "transition",
      record: { transition_id: "long_literal" },
    });
  });
  it("evaluates ordered and repeated predicates without array-order arbitration", () => {
    const event = (name: string) => ({
      kind: "event" as const,
      source: "shim" as const,
      exact: { name },
      ignore_fields: ["sequence" as const],
      since: { kind: "scenario_start" as const },
      consume: true,
      cardinality: { min: 1, max: 1 },
    });
    const scenario = scenarioWith([
      finish("sequence", {
        kind: "sequence",
        triggers: [
          event("start"),
          { kind: "repeat", trigger: event("tick"), min: 2, max: 2 },
          event("done"),
        ],
      }),
    ]);
    let snapshot = createProcessReactiveSnapshot(scenario);
    for (const [order, name] of ["start", "tick", "tick"].entries()) {
      const decision = offer(
        scenario,
        snapshot,
        observation("shim", order, { name, sequence: order }),
      );
      expect(decision.kind).toBe("waiting");
      snapshot = decision.snapshot;
    }
    const decision = offer(
      scenario,
      snapshot,
      observation("shim", 3, { name: "done", sequence: 3 }),
    );
    expect(decision.kind).toBe("transition");
    if (decision.kind === "transition")
      expect(decision.record.trigger_event_ids).toEqual([
        "obs.shim_events.0",
        "obs.shim_events.1",
        "obs.shim_events.2",
        "obs.shim_events.3",
      ]);
  });
  it("applies state-entry frontiers and explicit consumption", () => {
    const secondTrigger = {
      ...terminalTrigger(),
      since: { kind: "state_entry" as const },
      consume: true,
    };
    const scenario = processReactiveScenarioSchema.parse({
      initial_state: "one",
      deadline_ms: 30000,
      states: [
        {
          id: "one",
          max_visits: 1,
          deadline_ms: 5000,
          on: [
            {
              ...finish("advance", terminalTrigger()),
              target: { kind: "goto", state: "two" },
            },
          ],
        },
        {
          id: "two",
          max_visits: 1,
          deadline_ms: 5000,
          on: [finish("finish", secondTrigger)],
        },
      ],
    });
    const advanced = offer(
      scenario,
      createProcessReactiveSnapshot(scenario),
      observation("terminal_raw", 0, { data: "Ready" }),
    );
    expect(advanced.kind).toBe("transition");
    const waiting = offer(
      scenario,
      advanced.snapshot,
      observation("shim", 1, { name: "unrelated" }),
    );
    expect(waiting.kind).toBe("waiting");
    const finished = offer(
      scenario,
      waiting.snapshot,
      observation("terminal_raw", 2, { data: "Ready" }),
    );
    expect(finished.kind).toBe("transition");
    expect(finished.snapshot.consumed_event_ids).toEqual(["obs.frames.2"]);
  });
});

describe("process reactive runtime: visit and deadline classification", () => {
  it("rejects an exhausted state visit before proposing effects", () => {
    const scenario = processReactiveScenarioSchema.parse({
      initial_state: "loop",
      deadline_ms: 30000,
      states: [
        {
          id: "loop",
          max_visits: 1,
          deadline_ms: 5000,
          on: [
            {
              ...finish("again", terminalTrigger(), 100, [
                {
                  type: "send_signal",
                  target: { kind: "root" },
                  signal: "SIGKILL",
                },
              ]),
              target: { kind: "goto", state: "loop" },
            },
          ],
        },
      ],
    });
    const decision = reduceProcessReactiveScenario(
      scenario,
      createProcessReactiveSnapshot(scenario),
      {
        kind: "observation",
        observation: observation("terminal_raw", 0, { data: "Ready" }),
      },
    );
    expect(decision).toMatchObject({
      kind: "finished",
      outcome: "capture_incomplete",
    });
    expect(decision).not.toHaveProperty("effects");
  });
  it("classifies deadlines and non-monotonic observation input", () => {
    const scenario = scenarioWith([finish("ready", terminalTrigger())]);
    const initial = createProcessReactiveSnapshot(scenario);
    expect(
      reduceProcessReactiveScenario(scenario, initial, {
        kind: "state_deadline",
        state_id: "starting",
        state_entry_capture_order: 0,
      }),
    ).toMatchObject({ kind: "finished", outcome: "predicate_timeout" });
    expect(
      reduceProcessReactiveScenario(scenario, initial, {
        kind: "state_deadline",
        state_id: "previous",
        state_entry_capture_order: 0,
      }),
    ).toMatchObject({ kind: "waiting", snapshot: initial });
    expect(
      reduceProcessReactiveScenario(scenario, initial, {
        kind: "scenario_deadline",
      }),
    ).toMatchObject({ kind: "finished", outcome: "scenario_deadline" });
    expect(
      reduceProcessReactiveScenario(scenario, initial, { kind: "cancelled" }),
    ).toMatchObject({ kind: "finished", outcome: "cancelled" });
    expect(
      reduceProcessReactiveScenario(scenario, initial, {
        kind: "cleanup_failed",
      }),
    ).toMatchObject({ kind: "finished", outcome: "cleanup_failed" });
    const passed = offer(
      scenario,
      initial,
      observation("terminal_raw", 0, { data: "Ready" }),
    );
    expect(
      reduceProcessReactiveScenario(scenario, passed.snapshot, {
        kind: "cleanup_failed",
      }),
    ).toMatchObject({ kind: "finished", outcome: "cleanup_failed" });
    const first = offer(
      scenario,
      initial,
      observation("shim", 1, { name: "later" }),
    );
    const invalid = offer(
      scenario,
      first.snapshot,
      observation("shim", 0, { name: "earlier" }),
    );
    expect(invalid).toMatchObject({
      kind: "finished",
      outcome: "capture_incomplete",
    });
    const duplicate = observation("shim", 1, { name: "later" });
    expect(offer(scenario, first.snapshot, duplicate)).toMatchObject({
      kind: "finished",
      outcome: "capture_incomplete",
    });
    expect(
      offer(scenario, first.snapshot, {
        ...duplicate,
        payload: { name: "changed" },
      }),
    ).toMatchObject({ kind: "finished", outcome: "capture_incomplete" });
  });
});
