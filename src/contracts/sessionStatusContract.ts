import { z } from "zod";

/** Optional expectations used to compare the live session with its caller. */
export const binarySessionInputSchema = z.object({
  expected_package_version: z.string().min(1).optional(),
  expected_catalog_digest: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .optional(),
  expected_server_path: z.string().min(1).optional(),
});
