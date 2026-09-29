import { describe, expect, it } from "vitest";

import { processReactiveRunSchema } from "./processCaptureReactiveSchema.js";

describe("process reactive capture schema", () => {
  it("accepts every committed transition without a fixed journal ceiling", () => {
    const transitions = Array.from({ length: 130 }, (_, sequence) => ({
      sequence,
      transition_id: `transition_${String(sequence)}`,
      state_before: "active",
      state_after: "active",
      outcome: null,
      trigger_event_ids: Array.from(
        { length: 80 },
        (_, index) => `event_${String(index)}`,
      ),
      action_event_ids: Array.from(
        { length: 300 },
        (_, index) => `action_${String(index)}`,
      ),
      action_types: Array.from({ length: 300 }, () => "send_input" as const),
    }));

    const parsed = processReactiveRunSchema.safeParse({
      status: "running",
      outcome: null,
      active_state: "active",
      transitions,
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.transitions).toHaveLength(130);
  });
});
