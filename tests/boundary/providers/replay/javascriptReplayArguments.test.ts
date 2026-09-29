import { expect, it } from "vitest";

import { controlledReplayInputSchema } from "../../../../src/domain/javascriptReplay.js";

it("accepts replay case argument arrays beyond the former item ceiling", () => {
  const parsed = controlledReplayInputSchema.safeParse({
    mode: "plan",
    left: {
      modules: [
        {
          alias: "parser",
          path: "/tmp/parser.mjs",
          format: "esm",
          role: "module",
          dependencies: {},
        },
      ],
      entry_alias: "parser",
      entry_export: "default",
    },
    cases: [
      {
        case_id: "many-arguments",
        arguments: Array.from({ length: 17 }, (_, index) => index),
      },
    ],
  });

  expect(parsed.success).toBe(true);
});
