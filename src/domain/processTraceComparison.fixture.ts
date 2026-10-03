import { EMPTY_PROCESS_CAPTURE_EXAMPLE } from "./processCapture.fixture.js";
import { parseProcessCapture, type ProcessCapture } from "./processCapture.js";
import { type ProcessTraceSpecification } from "./processTraceComparison.js";

export const emptyCapture = parseProcessCapture(EMPTY_PROCESS_CAPTURE_EXAMPLE);
export const capture = (
  values: Pick<
    ProcessCapture,
    | "frames"
    | "process_samples"
    | "filesystem_checkpoints"
    | "protocol_events"
    | "shim_events"
  > & {
    readonly event_journal: NonNullable<ProcessCapture["event_journal"]>;
  },
  options: {
    readonly truncated?: boolean;
    readonly residualUnknowns?: ProcessCapture["residual_unknowns"];
  } = {},
): ProcessCapture =>
  parseProcessCapture({
    ...emptyCapture,
    frames: values.frames,
    process_samples: values.process_samples,
    filesystem_checkpoints: emptyCapture.filesystem_checkpoints,
    shim_events: values.shim_events,
    protocol_events: values.protocol_events,
    event_journal: [
      {
        capture_order: 0,
        collection: "filesystem_checkpoints",
        index: 0,
      },
      ...values.event_journal.map((entry) => ({
        ...entry,
        capture_order: entry.capture_order + 1,
      })),
      {
        capture_order: values.event_journal.length + 1,
        collection: "lifecycle",
        index: 0,
      },
      {
        capture_order: values.event_journal.length + 2,
        collection: "lifecycle",
        index: 1,
      },
      {
        capture_order: values.event_journal.length + 3,
        collection: "filesystem_checkpoints",
        index: 1,
      },
    ],
    truncated: options.truncated ?? false,
    residual_unknowns: options.residualUnknowns ?? [],
  });
export const terminal = { sequence: 0, at_ms: 900, data: "Ready" };
export const processStarted = {
  at_ms: 1,
  pid: 1,
  parent_pid: 0,
  command: "worker",
  process_group_id: 1,
  session_id: 1,
};
export const http = {
  sequence: 0,
  at_ms: 2,
  protocol: "http" as const,
  direction: "request" as const,
  method: "GET",
  path: "/status",
  data: "",
  outcome: "unmatched" as const,
};
export const websocket = {
  sequence: 1,
  at_ms: 3,
  protocol: "websocket" as const,
  direction: "received" as const,
  method: null,
  path: "/ws",
  data: "done",
  outcome: "matched" as const,
};
export const values = (
  order: readonly ("terminal" | "process" | "http" | "websocket")[],
): Parameters<typeof capture>[0] => ({
  frames: [terminal],
  process_samples: [processStarted],
  filesystem_checkpoints: [],
  protocol_events: [http, websocket],
  shim_events: [],
  event_journal: order.map((event, captureOrder) => ({
    capture_order: captureOrder,
    collection:
      event === "terminal"
        ? "frames"
        : event === "process"
          ? "process_samples"
          : "protocol_events",
    index: event === "websocket" ? 1 : 0,
  })),
});
export const partialSpecification = (): ProcessTraceSpecification => ({
  events: [
    {
      id: "ready",
      source: "terminal_raw",
      exact: terminal,
      cardinality: { kind: "required" },
    },
    {
      id: "worker",
      source: "process",
      exact: processStarted,
      cardinality: { kind: "required" },
    },
    {
      id: "status",
      source: "http",
      exact: http,
      cardinality: { kind: "required" },
    },
    {
      id: "done",
      source: "websocket",
      exact: websocket,
      cardinality: { kind: "required" },
    },
  ],
  language: {
    kind: "partial_order",
    happens_before: [
      { before: "ready", after: "worker" },
      { before: "ready", after: "status" },
      { before: "worker", after: "done" },
      { before: "status", after: "done" },
    ],
    not_before: [{ event: "done", anchor: "ready" }],
    unordered_groups: [{ events: ["worker", "status"] }],
    prefix: ["ready"],
    suffix: ["done"],
  },
});
