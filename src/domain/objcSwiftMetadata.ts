import { z } from "zod";

/** Objective-C method type. */
export const objcMethodTypeSchema = z.enum([
  "instance",
  "class",
  "ivar_getter",
  "ivar_setter",
]);
export type ObjcMethodType = z.infer<typeof objcMethodTypeSchema>;

/** Objective-C property attribute. */
export const objcPropertyAttributeSchema = z.strictObject({
  name: z.string().min(1),
  value: z.string(),
  is_weak: z.boolean().default(false),
  is_atomic: z.boolean().default(false),
  is_copy: z.boolean().default(false),
  is_strong: z.boolean().default(false),
});
export type ObjcPropertyAttribute = z.infer<typeof objcPropertyAttributeSchema>;

/** Objective-C method metadata. */
export const objcMethodSchema = z.strictObject({
  selector: z.string().min(1),
  method_type: objcMethodTypeSchema,
  address: z.number().int().nullable(),
  is_required: z.boolean().default(false),
  is_optional: z.boolean().default(false),
});
export type ObjcMethod = z.infer<typeof objcMethodSchema>;

/** Objective-C property metadata. */
export const objcPropertySchema = z.strictObject({
  name: z.string().min(1),
  type_encoding: z.string().nullable(),
  attributes: z.array(objcPropertyAttributeSchema).default([]),
  is_readonly: z.boolean().default(false),
  getter: z.string().nullable(),
  setter: z.string().nullable(),
});
export type ObjcProperty = z.infer<typeof objcPropertySchema>;

/** Objective-C protocol metadata. */
export const objcProtocolSchema = z.strictObject({
  name: z.string().min(1),
  methods: z.array(objcMethodSchema).default([]),
  optional_methods: z.array(objcMethodSchema).default([]),
  properties: z.array(objcPropertySchema).default([]),
});
export type ObjcProtocol = z.infer<typeof objcProtocolSchema>;

/** Objective-C class metadata. */
export const objcClassSchema = z.strictObject({
  name: z.string().min(1),
  super_class: z.string().nullable(),
  is_meta_class: z.boolean().default(false),
  is_root_class: z.boolean().default(false),
  methods: z.array(objcMethodSchema).default([]),
  properties: z.array(objcPropertySchema).default([]),
  protocols: z.array(z.string()).default([]),
  ivar_count: z.number().int().nonnegative().default(0),
  instance_size: z.number().int().nonnegative().nullable(),
});
export type ObjcClass = z.infer<typeof objcClassSchema>;

/** Swift declaration kind. */
export const swiftDeclKindSchema = z.enum([
  "class",
  "struct",
  "enum",
  "protocol",
  "extension",
  "actor",
  "global_var",
  "global_func",
]);
export type SwiftDeclKind = z.infer<typeof swiftDeclKindSchema>;

/** Swift access level. */
export const swiftAccessLevelSchema = z.enum([
  "private",
  "fileprivate",
  "internal",
  "public",
  "open",
]);
export type SwiftAccessLevel = z.infer<typeof swiftAccessLevelSchema>;
/** Swift declaration metadata. */
export const swiftDeclSchema = z.strictObject({
  kind: swiftDeclKindSchema,
  name: z.string().min(1),
  module: z.string().nullable(),
  access_level: swiftAccessLevelSchema.default("internal"),
  super_class: z.string().nullable(),
  protocols: z.array(z.string()).default([]),
  is_final: z.boolean().default(false),
  is_required: z.boolean().default(false),
  is_convenience_init: z.boolean().default(false),
  is_override: z.boolean().default(false),
});
export type SwiftDecl = z.infer<typeof swiftDeclSchema>;

/** Database save/read operation type. */
export const dbOperationSchema = z.enum([
  "save",
  "readback",
  "open_database",
  "close_database",
  "export",
  "import",
]);
export type DbOperation = z.infer<typeof dbOperationSchema>;

/** Database save operation result. */
export const dbSaveResultSchema = z.strictObject({
  operation: dbOperationSchema,
  succeeded: z.boolean(),
  preserved_names: z.number().int().nonnegative().default(0),
  preserved_comments: z.number().int().nonnegative().default(0),
  preserved_bookmarks: z.number().int().nonnegative().default(0),
  database_path: z.string().nullable(),
  error: z.string().nullable(),
});
export type DbSaveResult = z.infer<typeof dbSaveResultSchema>;

/** Result of deeper ObjC/Swift metadata extraction. */
export const objcSwiftMetadataSchema = z.strictObject({
  objc_classes: z.array(objcClassSchema).default([]),
  objc_protocols: z.array(objcProtocolSchema).default([]),
  swift_decls: z.array(swiftDeclSchema).default([]),
  db_save_result: dbSaveResultSchema.nullable(),
});
export type ObjcSwiftMetadata = z.infer<typeof objcSwiftMetadataSchema>;

/** Check if a selector name looks like a getter. */
export function isGetterSelector(selector: string): boolean {
  return /^[a-z][a-zA-Z0-9_]*$/u.test(selector) && !selector.includes(":");
}

/** Check if a selector name looks like a setter. */
export function isSetterSelector(selector: string): boolean {
  return selector.startsWith("set") && selector.endsWith(":");
}

/** Extract property name from a getter/setter selector. */
export function propertyNameFromSelector(selector: string): string | null {
  if (isSetterSelector(selector)) {
    const inner = selector.slice(3, -1);
    return inner.charAt(0).toLowerCase() + inner.slice(1);
  }
  if (isGetterSelector(selector)) {
    return selector;
  }
  return null;
}

/** Count ObjC methods by type. */
export function countMethodsByType(
  methods: readonly ObjcMethod[],
): Record<ObjcMethodType, number> {
  return {
    instance: methods.filter((m) => m.method_type === "instance").length,
    class: methods.filter((m) => m.method_type === "class").length,
    ivar_getter: methods.filter((m) => m.method_type === "ivar_getter").length,
    ivar_setter: methods.filter((m) => m.method_type === "ivar_setter").length,
  };
}

/** Get all Swift declarations of a specific kind. */
export function swiftDeclsByKind(
  decls: readonly SwiftDecl[],
  kind: SwiftDeclKind,
): SwiftDecl[] {
  return decls.filter((d) => d.kind === kind);
}

/** Check if a database save preserved all expected items. */
export function isDbSaveComplete(
  result: DbSaveResult,
  expectedNames: number,
  expectedComments: number,
  expectedBookmarks: number,
): boolean {
  return (
    result.succeeded &&
    result.preserved_names >= expectedNames &&
    result.preserved_comments >= expectedComments &&
    result.preserved_bookmarks >= expectedBookmarks
  );
}
