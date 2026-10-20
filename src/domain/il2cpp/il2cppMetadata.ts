import { z } from "zod";
import { digestSchema } from "../digests.js";
import { localPathStringSchema } from "../localPath.js";
import { canonicalBase64Schema } from "../stringPatterns.js";

/** Unsigned little-endian signature observed at file offset zero. */
export const IL2CPP_METADATA_MAGIC = 0xfab11baf;

/** Header section order shared by global-metadata.dat versions 29, 31 and 39. */
export const IL2CPP_METADATA_SECTION_NAMES = [
  "stringLiterals",
  "stringLiteralData",
  "strings",
  "events",
  "properties",
  "methods",
  "parameterDefaultValues",
  "fieldDefaultValues",
  "fieldAndParameterDefaultValueData",
  "fieldMarshaledSizes",
  "parameters",
  "fields",
  "genericParameters",
  "genericParameterConstraints",
  "genericContainers",
  "nestedTypes",
  "interfaces",
  "vtableMethods",
  "interfaceOffsets",
  "typeDefinitions",
  "images",
  "assemblies",
  "fieldRefs",
  "referencedAssemblies",
  "attributeData",
  "attributeDataRanges",
  "unresolvedIndirectCallParameterTypes",
  "unresolvedIndirectCallParameterRanges",
  "windowsRuntimeTypeNames",
  "windowsRuntimeStrings",
  "exportedTypeDefinitions",
] as const;

/** Version 27 names for the four custom-attribute and indirect-call sections. */
export const IL2CPP_METADATA_V27_SECTION_NAMES = [
  ...IL2CPP_METADATA_SECTION_NAMES.slice(0, 24),
  "attributesInfo",
  "attributeTypes",
  "unresolvedVirtualCallParameterTypes",
  "unresolvedVirtualCallParameterRanges",
  ...IL2CPP_METADATA_SECTION_NAMES.slice(28),
] as const;

/** Version 24 header: 32 (offset, byte size) pairs in this order. */
export const IL2CPP_METADATA_V24_SECTION_NAMES = [
  ...IL2CPP_METADATA_SECTION_NAMES.slice(0, 22),
  "metadataUsageLists",
  "metadataUsagePairs",
  "fieldRefs",
  "referencedAssemblies",
  "attributesInfo",
  "attributeTypes",
  "unresolvedVirtualCallParameterTypes",
  "unresolvedVirtualCallParameterRanges",
  "windowsRuntimeTypeNames",
  "exportedTypeDefinitions",
] as const;

/** Decoded metadata versions; all but 39 use fixed 4-byte indices. */
export const IL2CPP_METADATA_VERSIONS = [24, 27, 29, 31, 39] as const;

/** Header section names in order for one metadata version. */
export const il2cppMetadataSectionNames = (
  version: number,
): readonly IL2cppMetadataSectionName[] =>
  version === 24
    ? IL2CPP_METADATA_V24_SECTION_NAMES
    : version === 27
      ? IL2CPP_METADATA_V27_SECTION_NAMES
      : IL2CPP_METADATA_SECTION_NAMES;

const count = z.number().int().nonnegative();
/** Serialized metadata indices use -1 for an absent reference. */
const optionalIndex = z.number().int().min(-1);
const indexWidth = z.union([z.literal(1), z.literal(2), z.literal(4)]);

/** One explicit local file; detail selects delivery, never decoding coverage. */
export const inspectIl2cppMetadataInputSchema = z.strictObject({
  path: localPathStringSchema.describe(
    "Absolute filesystem path to a Unity IL2CPP global-metadata.dat file",
  ),
  detail: z
    .enum(["complete", "summary"])
    .default("summary")
    .describe(
      "summary (default) retains complete Evidence and returns identity and collection counts; complete returns every image, type, method, member, parameter and string-literal row inline",
    ),
});

export type IL2cppMetadataSectionName = z.infer<
  typeof il2cppMetadataSectionSchema
>["name"];

export const il2cppMetadataSectionSchema = z.strictObject({
  name: z.enum([
    ...IL2CPP_METADATA_SECTION_NAMES,
    "attributesInfo",
    "attributeTypes",
    "unresolvedVirtualCallParameterTypes",
    "unresolvedVirtualCallParameterRanges",
    "metadataUsageLists",
    "metadataUsagePairs",
  ]),
  offset: count,
  size: count,
  /** Header-recorded entry count; versions 29 and 31 record none. */
  count: count.nullable(),
});

/** Assembly image and its contiguous type-definition range. */
export const il2cppMetadataImageSchema = z.strictObject({
  name: z.string(),
  type_start: optionalIndex,
  type_count: count,
});

/** Type definition; row position is its TypeDefinitionIndex. */
export const il2cppMetadataTypeSchema = z.strictObject({
  name: z.string(),
  namespace: z.string(),
  method_start: optionalIndex,
  method_count: count,
  nested_type_start: optionalIndex,
  nested_type_count: count,
  /** Enclosing type derived from the nestedTypes section. */
  declaring_type: optionalIndex.describe(
    "Enclosing TypeDefinitionIndex derived from nestedTypes; -1 means no enclosing metadata type was recorded",
  ),
});

/** Method definition; row position is its MethodIndex. */
export const il2cppMetadataMethodSchema = z.strictObject({
  name: z.string(),
  declaring_type: optionalIndex.describe(
    "Declared TypeDefinitionIndex from this MethodDefinition; -1 is an absent reference",
  ),
});

/** Field, property or event name and the type whose member range holds it. */
export const il2cppMetadataMemberSchema = z.strictObject({
  name: z.string(),
  /** -1 when no type range claims the row. */
  declaring_type: optionalIndex,
});

/** Parameter name and the method whose parameter range holds it. */
export const il2cppMetadataParameterSchema = z.strictObject({
  name: z.string(),
  /** -1 when no method range claims the row. */
  method: optionalIndex,
});

/** Managed string literal; undecodable UTF-8 keeps its exact bytes instead. */
export const il2cppMetadataStringLiteralSchema = z.strictObject({
  value: z.string().nullable(),
  value_base64: canonicalBase64Schema.nullable(),
});

/** Unrefined report fields, shared with projections that omit row collections. */
export const il2cppMetadataObjectSchema = z.strictObject({
  artifact: z.strictObject({
    path: localPathStringSchema,
    sha256: digestSchema,
    bytes: count,
  }),
  magic: z.literal(IL2CPP_METADATA_MAGIC),
  metadata_version: z.union(
    IL2CPP_METADATA_VERSIONS.map((version) => z.literal(version)),
  ),
  index_widths: z.strictObject({
    type_definition: indexWidth,
    generic_container: indexWidth,
    parameter: indexWidth,
    type: indexWidth,
    type_width_source: z.enum([
      "interface-offsets-record",
      "type-definition-record",
      "fixed-width-version",
    ]),
  }),
  sections: z.array(il2cppMetadataSectionSchema),
  images: z.array(il2cppMetadataImageSchema),
  types: z.array(il2cppMetadataTypeSchema),
  methods: z.array(il2cppMetadataMethodSchema),
  fields: z.array(il2cppMetadataMemberSchema),
  properties: z.array(il2cppMetadataMemberSchema),
  events: z.array(il2cppMetadataMemberSchema),
  parameters: z.array(il2cppMetadataParameterSchema),
  string_literals: z.array(il2cppMetadataStringLiteralSchema),
  limitations: z.array(z.string()),
});

/** Complete name and count inventory of one decoded global-metadata.dat file. */
export const il2cppMetadataMemberCollections = [
  "fields",
  "properties",
  "events",
  "parameters",
  "string_literals",
] as const;

/** Historical reports retain omission instead of inventing empty member inventories. */
const il2cppMetadataParentObjectSchema = il2cppMetadataObjectSchema.partial({
  fields: true,
  properties: true,
  events: true,
  parameters: true,
  string_literals: true,
});

const validateMetadataFacts = (
  report: z.infer<typeof il2cppMetadataParentObjectSchema>,
  context: z.RefinementCtx,
): void => {
  const names = il2cppMetadataSectionNames(report.metadata_version);
  if (report.sections.length !== names.length)
    context.addIssue({
      code: "custom",
      path: ["sections"],
      message: `Version ${report.metadata_version} headers have ${names.length} sections.`,
    });
  report.sections.forEach((section, index) => {
    if (section.name !== names[index])
      context.addIssue({
        code: "custom",
        path: ["sections", index, "name"],
        message: "Sections must follow header order.",
      });
    if (section.offset + section.size > report.artifact.bytes)
      context.addIssue({
        code: "custom",
        path: ["sections", index],
        message: "Section range is outside the selected artifact.",
      });
  });
  for (const collection of ["fields", "properties", "events"] as const)
    report[collection]?.forEach((row, index) => {
      if (row.declaring_type >= report.types.length)
        context.addIssue({
          code: "custom",
          path: [collection, index, "declaring_type"],
          message: "Member owner is outside the retained type definitions.",
        });
    });
  report.parameters?.forEach((row, index) => {
    if (row.method >= report.methods.length)
      context.addIssue({
        code: "custom",
        path: ["parameters", index, "method"],
        message: "Parameter owner is outside the retained method definitions.",
      });
  });
  report.string_literals?.forEach((row, index) => {
    if ((row.value === null) === (row.value_base64 === null))
      context.addIssue({
        code: "custom",
        path: ["string_literals", index],
        message:
          "A literal must retain exactly one UTF-8 or byte-exact base64 representation.",
      });
  });
};

export const il2cppMetadataSchema = il2cppMetadataObjectSchema.superRefine(
  validateMetadataFacts,
);
export const il2cppMetadataParentSchema =
  il2cppMetadataParentObjectSchema.superRefine(validateMetadataFacts);

export type InspectIl2cppMetadataInput = z.infer<
  typeof inspectIl2cppMetadataInputSchema
>;
export type Il2cppMetadataProviderInput = Omit<
  InspectIl2cppMetadataInput,
  "detail"
>;
export type Il2cppMetadataSection = z.infer<typeof il2cppMetadataSectionSchema>;
export type Il2cppMetadata = z.infer<typeof il2cppMetadataSchema>;
