import { expect, it } from "vitest";

import {
  parseProcessScenario,
  PROCESS_TERMINAL_CELL_BUDGET,
  processScenarioSchema,
} from "./processScenario.js";

it("admits the default and the exact combined terminal-cell budget", () => {
  expect(parseProcessScenario({ executable: "/bin/true" }).terminal).toEqual({
    columns: 80,
    rows: 24,
    scrollback: 1_000,
  });

  expect(
    processScenarioSchema.safeParse({
      executable: "/bin/true",
      terminal: {
        columns: 1,
        rows: 1,
        scrollback: PROCESS_TERMINAL_CELL_BUDGET - 1,
      },
    }).success,
  ).toBe(true);
});

it("rejects an oversized initial buffer without clamping caller dimensions", () => {
  const input = {
    executable: "/bin/true",
    terminal: { columns: 1_000, rows: 1, scrollback: 1_000 },
  };
  const parsed = processScenarioSchema.safeParse(input);

  expect(parsed.success).toBe(false);
  if (parsed.success) throw new Error("expected terminal capacity rejection");
  expect(parsed.error.issues).toContainEqual(
    expect.objectContaining({
      code: "custom",
      path: ["terminal"],
      message: expect.stringContaining(
        `${String(PROCESS_TERMINAL_CELL_BUDGET)} renderer cells`,
      ),
    }),
  );
});

it("applies the selected scrollback budget to every scheduled resize", () => {
  const parsed = processScenarioSchema.safeParse({
    executable: "/bin/true",
    events: [{ type: "resize", at_ms: 10, columns: 1_000, rows: 1 }],
  });

  expect(parsed.success).toBe(false);
  if (parsed.success) throw new Error("expected resize capacity rejection");
  expect(parsed.error.issues).toContainEqual(
    expect.objectContaining({
      code: "custom",
      path: ["events", 0],
      message: expect.stringContaining("resize event at 10 ms"),
    }),
  );

  expect(
    processScenarioSchema.safeParse({
      executable: "/bin/true",
      terminal: { columns: 1, rows: 1, scrollback: 0 },
      events: [{ type: "resize", at_ms: 10, columns: 1_000, rows: 1 }],
    }).success,
  ).toBe(true);
});
