import { err, ok, type Result } from "../result.js";

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** CPython marshal uses UTF-8 surrogatepass; all other malformed bytes fail. */
export const decodeMarshalUtf8 = (
  bytes: Buffer,
): Result<string, { readonly kind: "invalid-marshal-utf8" }> => {
  const chunks: string[] = [];
  let start = 0;
  try {
    for (
      let offset = bytes.indexOf(0xed);
      offset !== -1;
      offset = bytes.indexOf(0xed, offset + 1)
    ) {
      const second = bytes[offset + 1];
      const third = bytes[offset + 2];
      if (
        second === undefined ||
        second < 0xa0 ||
        second > 0xbf ||
        third === undefined ||
        third < 0x80 ||
        third > 0xbf
      )
        continue;
      // Only ED A0..BF 80..BF encodes a surrogate. The fatal decoder owns
      // every unchanged span, including incomplete scalars on either side.
      chunks.push(
        UTF8.decode(bytes.subarray(start, offset)),
        String.fromCharCode(0xd000 | ((second & 0x3f) << 6) | (third & 0x3f)),
      );
      start = offset + 3;
      offset += 2;
    }
    if (start === 0) return ok(UTF8.decode(bytes));
    chunks.push(UTF8.decode(bytes.subarray(start)));
    return ok(chunks.join(""));
  } catch (cause: unknown) {
    if (cause instanceof TypeError)
      return err({ kind: "invalid-marshal-utf8" });
    throw cause;
  }
};
