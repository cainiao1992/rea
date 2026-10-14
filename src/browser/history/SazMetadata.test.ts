import { expect, it } from "vitest";
import { decodeSazMetadata } from "./SazMetadata.js";

it("retains U+FFFD in well-formed metadata as an ordinary XML character", () => {
  const decoded = JSON.stringify(
    decodeSazMetadata(
      Buffer.from(
        '<Session><SessionFlag N="ui-comments" V="caf�"/>�</Session>',
      ),
    ),
  );
  expect(decoded).toContain('{"name":"V","value":"caf�"}');
  expect(decoded).toContain('"value":"�"');
});

it.each([
  "<Session a=1>�</Session>",
  '<Session a="x"b="�"/>',
  "<Session><Broken>�</Session>",
])("still rejects malformed metadata that also contains U+FFFD: %j", (xml) => {
  expect(() => decodeSazMetadata(Buffer.from(xml))).toThrow(
    "SAZ metadata is not well-formed XML.",
  );
});
