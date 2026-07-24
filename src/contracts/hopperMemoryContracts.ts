import { z } from "zod";

const document = z.string().optional().describe("The document name");
const address = z
  .string()
  .describe(
    "A provider-normalized address; default memory uses 0x-prefixed hexadecimal",
  );

/** Bounded Hopper memory and file-mapping contracts. */
export const HOPPER_MEMORY_TOOL_DEFINITIONS = [
  {
    name: "read_bytes",
    description:
      "Read at most 4,096 analyzed bytes from one provider-normalized virtual address. The hexadecimal payload reports the exact returned length; incomplete reads remain explicit and unsupported provider APIs return typed capability unavailability.",
    inputSchema: z.object({
      address,
      length: z.number().int().min(1).max(4_096).default(256),
      document,
    }),
  },
  {
    name: "address_to_file_offset",
    description:
      "Map one provider-normalized virtual address to its original nonnegative file offset. Unmapped addresses fail explicitly, and providers without an authoritative mapping API return typed capability unavailability.",
    inputSchema: z.object({ address, document }),
  },
] as const;
