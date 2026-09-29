import { describe, expect, it } from "vitest";

import { redactSensitiveText } from "./SensitiveTextCapture.js";

describe("sensitive console text", () => {
  it("redacts assignments, bearer credentials, and JWT-shaped values", () => {
    const jwt = "eyJabcdefghijk.abcdefghijkl.abcdefghijk";
    expect(
      redactSensitiveText(
        `authorization=Bearer abc.def password='hunter2' api_key=key ${jwt}`,
      ),
    ).toBe(
      "authorization=[REDACTED] password=[REDACTED] api_key=[REDACTED] [REDACTED_JWT]",
    );
  });
});
