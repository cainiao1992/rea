import { describe, expect, it } from "vitest";

import {
  countMethodsByType,
  isDbSaveComplete,
  isGetterSelector,
  isSetterSelector,
  objcSwiftMetadataSchema,
  propertyNameFromSelector,
  swiftDeclsByKind,
  type ObjcClass,
  type ObjcMethod,
  type ObjcProperty,
  type DbOperation,
  type ObjcSwiftMetadata,
  type ObjcProtocol,
  type ObjcPropertyAttribute,
  type SwiftDecl,
  type SwiftAccessLevel,
  type DbSaveResult,
} from "../src/domain/objcSwiftMetadata.js";

describe("ObjC/Swift metadata", () => {
  it("identifies getter selectors", () => {
    expect(isGetterSelector("name")).toBe(true);
    expect(isGetterSelector("setName:")).toBe(false);
    expect(isGetterSelector("set")).toBe(true);
  });

  it("identifies setter selectors", () => {
    expect(isSetterSelector("setName:")).toBe(true);
    expect(isSetterSelector("name")).toBe(false);
  });

  it("extracts property name from selector", () => {
    expect(propertyNameFromSelector("name")).toBe("name");
    expect(propertyNameFromSelector("setName:")).toBe("name");
    expect(propertyNameFromSelector("set")).toBe("set");
  });

  it("counts methods by type", () => {
    const methods: ObjcMethod[] = [
      {
        selector: "init",
        method_type: "instance",
        address: 0x1000,
        is_required: false,
        is_optional: false,
      },
      {
        selector: "alloc",
        method_type: "class",
        address: 0x2000,
        is_required: false,
        is_optional: false,
      },
    ];
    const counts = countMethodsByType(methods);
    expect(counts.instance).toBe(1);
    expect(counts.class).toBe(1);
    expect(counts.ivar_getter).toBe(0);
    expect(counts.ivar_setter).toBe(0);
  });

  it("filters Swift declarations by kind", () => {
    const decls: SwiftDecl[] = [
      {
        kind: "class",
        name: "Foo",
        module: null,
        access_level: "public",
        super_class: null,
        protocols: [],
        is_final: false,
        is_required: false,
        is_convenience_init: false,
        is_override: false,
      },
    ];
    const classes = swiftDeclsByKind(decls, "class");
    expect(classes).toHaveLength(1);
    expect(classes[0]!.name).toBe("Foo");
  });

  it("checks database save completeness", () => {
    const result: DbSaveResult = {
      operation: "save",
      succeeded: true,
      preserved_names: 10,
      preserved_comments: 5,
      preserved_bookmarks: 3,
      database_path: "/tmp/db.hop",
      error: null,
    };
    expect(isDbSaveComplete(result, 10, 5, 3)).toBe(true);
    expect(isDbSaveComplete(result, 11, 5, 3)).toBe(false);
  });

  it("validates a well-formed metadata result", () => {
    const meta = {
      objc_classes: [] as ObjcClass[],
      objc_protocols: [] as ObjcProtocol[],
      swift_decls: [] as SwiftDecl[],
      db_save_result: null,
    };
    const result = objcSwiftMetadataSchema.safeParse(meta);
    expect(result.success).toBe(true);
  });

  it("uses all exported types", () => {
    const prop: ObjcProperty = {
      name: "title",
      type_encoding: 'T@"NSString"&,N,V_title',
      attributes: [] as ObjcPropertyAttribute[],
      is_readonly: false,
      getter: "title",
      setter: "setTitle:",
    };
    expect(prop.name).toBe("title");
    const op: DbOperation = "save";
    expect(op).toBe("save");
    const meta: ObjcSwiftMetadata = {
      objc_classes: [],
      objc_protocols: [],
      swift_decls: [],
      db_save_result: null,
    };
    expect(meta.objc_classes).toHaveLength(0);
  });
});
