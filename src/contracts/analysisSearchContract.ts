import { z } from "zod";

/** Shared bounded provider search input fields. */
export const analysisSearchInput = {
  pattern: z
    .string()
    .min(1)
    .max(256)
    .describe("The literal text or bounded regex pattern to search for"),
  mode: z.enum(["literal", "regex"]).default("literal"),
  case_sensitive: z.boolean().default(false).describe("Whether to match case"),
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(100).default(100),
  document: z.string().optional().describe("The document name"),
};
