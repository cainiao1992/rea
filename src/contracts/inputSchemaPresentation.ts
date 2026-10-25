import {
  JsonSchemaReferences,
  type JsonSchemaScope,
} from "./jsonSchemaReferences.js";
import { isDeepStrictEqual } from "node:util";

import {
  schemaArrays,
  schemaChildren,
  schemaMaps,
} from "./jsonSchemaKeywords.js";
import {
  compactAdvertisedInputSchema,
  presentAdvertisedInputSchema,
  type CompactInputSchemaPresentation,
} from "./compactInputSchema.js";

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const referencedDescription = (
  references: JsonSchemaReferences,
  schema: Readonly<Record<string, unknown>>,
  inherited: JsonSchemaScope | undefined,
): string | undefined => {
  let value: unknown = schema;
  let scope = inherited;
  const active = new Set<object>();
  while (isObject(value)) {
    scope = references.enter(value, scope);
    if (
      typeof value.description === "string" &&
      (typeof value.$ref !== "string" || scope?.dialect !== "draft-07")
    )
      return value.description;
    if (typeof value.$ref !== "string" || active.has(value)) return undefined;
    active.add(value);
    const target = references.resolve(scope, value.$ref);
    if (target.kind !== "target") return undefined;
    value = target.value;
  }
  return undefined;
};

const describeSchema = (
  schema: unknown,
  references: JsonSchemaReferences,
  inherited: JsonSchemaScope | undefined,
  describeProperty: (property: string) => string | undefined,
): unknown => {
  if (!isObject(schema)) return schema;
  const scope = references.enter(schema, inherited);
  return Object.fromEntries(
    Object.entries(schema).map(([key, value]) => {
      if (schemaMaps.has(key) && isObject(value))
        return [
          key,
          Object.fromEntries(
            Object.entries(value).map(([name, child]) => {
              const described = describeSchema(
                child,
                references,
                scope,
                describeProperty,
              );
              if (
                key !== "properties" ||
                !isObject(described) ||
                !isObject(child)
              )
                return [name, described];
              const description =
                referencedDescription(references, child, scope) ??
                describeProperty(name);
              return [
                name,
                description === undefined
                  ? described
                  : { ...described, description },
              ];
            }),
          ),
        ];
      if (schemaArrays.has(key) && Array.isArray(value))
        return [
          key,
          value.map((child) =>
            describeSchema(child, references, scope, describeProperty),
          ),
        ];
      if (schemaChildren.has(key))
        return [
          key,
          Array.isArray(value)
            ? value.map((child) =>
                describeSchema(child, references, scope, describeProperty),
              )
            : describeSchema(value, references, scope, describeProperty),
        ];
      // Annotation values and literal const/enum data are not schemas.
      return [key, value];
    }),
  );
};

const objectBranch = (
  references: JsonSchemaReferences,
  branch: unknown,
): Readonly<Record<string, unknown>> | undefined => {
  // Reference siblings evaluate separately from the target in 2020-12, so a
  // merged object could accept inputs the branch rejects.
  let resolved = branch;
  if (isObject(branch) && typeof branch.$ref === "string") {
    if (Object.keys(branch).length !== 1) return undefined;
    const target = references.resolve(references.rootScope, branch.$ref);
    if (target.kind !== "target") return undefined;
    resolved = target.value;
  }
  return isObject(resolved) &&
    references.enter(resolved, references.rootScope) === references.rootScope &&
    ![
      "$id",
      "$schema",
      "$anchor",
      "$dynamicAnchor",
      "$recursiveAnchor",
      "$dynamicRef",
      "$recursiveRef",
    ].some((key) => Object.hasOwn(resolved, key)) &&
    resolved.type === "object" &&
    isObject(resolved.properties)
    ? resolved
    : undefined;
};

const requiredProperties = (
  branch: Readonly<Record<string, unknown>>,
): readonly string[] =>
  Array.isArray(branch.required)
    ? branch.required.filter((name) => typeof name === "string")
    : [];

const sharedRequiredProperties = (
  branches: readonly Readonly<Record<string, unknown>>[],
): readonly string[] => {
  const [first = [], ...others] = branches.map(requiredProperties);
  return first.filter((name) => others.every((names) => names.includes(name)));
};

const inputGroup = (branch: Readonly<Record<string, unknown>>): string => {
  const required = requiredProperties(branch);
  const optional = Object.keys(branch.properties ?? {})
    .filter((name) => !required.includes(name))
    .map((name) => `[${name}]`);
  return [...required, ...optional].join(" + ");
};

type SchemaNormalization = {
  readonly schema: unknown;
  readonly changed: boolean;
};

const serializedBytes = (value: unknown): number =>
  Buffer.byteLength(JSON.stringify(value), "utf8");

/** Instance nesting levels below the current node that keep their structure. */
type SchemaSummary = { readonly levels: number };

// Keywords whose subschemas describe a nested instance. Combinators,
// conditionals and dependent schemas describe the same instance as their parent.
const instanceChildKeys = new Set([
  "properties",
  "patternProperties",
  "additionalProperties",
  "unevaluatedProperties",
  "propertyNames",
  "prefixItems",
  "items",
  "additionalItems",
  "contains",
  "unevaluatedItems",
]);

const hasNestedSchema = (schema: Readonly<Record<string, unknown>>): boolean =>
  Object.entries(schema).some(([key, child]) =>
    schemaMaps.has(key)
      ? isObject(child) && Object.values(child).some(isObject)
      : schemaArrays.has(key)
        ? Array.isArray(child) && child.length > 0
        : schemaChildren.has(key) && isObject(child),
  );

/** Count nested instance levels a schema describes, ignoring literal data. */
const schemaLevels = (schema: unknown): number => {
  if (!isObject(schema)) return 0;
  let deepest = 0;
  for (const [key, child] of Object.entries(schema)) {
    const children = schemaMaps.has(key)
      ? isObject(child)
        ? Object.values(child)
        : []
      : schemaArrays.has(key)
        ? Array.isArray(child)
          ? child
          : []
        : schemaChildren.has(key)
          ? [child]
          : [];
    const step = instanceChildKeys.has(key) ? 1 : 0;
    for (const nested of children)
      if (isObject(nested))
        deepest = Math.max(deepest, step + schemaLevels(nested));
  }
  return deepest;
};

const literalType = (value: unknown): string => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number")
    return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
};

const typeKeyword = (types: readonly string[]): string | string[] =>
  types.length === 1 ? types[0]! : [...types];

/** Every JSON type a schema can accept, or undefined when that is not explicit. */
const schemaTypes = (schema: unknown): readonly string[] | undefined => {
  if (!isObject(schema)) return undefined;
  if (typeof schema.type === "string") return [schema.type];
  if (
    Array.isArray(schema.type) &&
    schema.type.length > 0 &&
    schema.type.every((type) => typeof type === "string")
  )
    return schema.type;
  const literals = Object.hasOwn(schema, "const")
    ? [schema.const]
    : Array.isArray(schema.enum) && schema.enum.length > 0
      ? schema.enum
      : undefined;
  if (literals !== undefined) return [...new Set(literals.map(literalType))];
  const branches = Array.isArray(schema.anyOf)
    ? schema.anyOf
    : Array.isArray(schema.oneOf)
      ? schema.oneOf
      : [];
  const types = branches.map(schemaTypes);
  return types.length > 0 && types.every((type) => type !== undefined)
    ? [...new Set(types.flat())]
    : undefined;
};

/** Item types of an explicitly typed array, including tuple positions. */
const typedArrayItemTypes = (
  schema: Readonly<Record<string, unknown>>,
): readonly string[] | undefined => {
  // Tuple positions come from `prefixItems` (2020-12) or an `items` array
  // (draft-07); later elements from `items` or `additionalItems`.
  const positions = [
    ...(Array.isArray(schema.prefixItems) ? schema.prefixItems : []),
    ...(Array.isArray(schema.items) ? schema.items : []),
  ];
  const rest = Array.isArray(schema.items)
    ? schema.additionalItems
    : schema.items;
  // An absent or `true` rest schema admits any later element.
  if (rest !== false && !isObject(rest)) return undefined;
  const types = [...positions, ...(rest === false ? [] : [rest])].map(
    schemaTypes,
  );
  return types.every((type) => type !== undefined)
    ? [...new Set(types.flat())]
    : undefined;
};

/** Every type an array accepted by the schema can contain, when explicit. */
const arrayItemTypes = (schema: unknown): readonly string[] | undefined => {
  if (!isObject(schema)) return undefined;
  const types = schemaTypes(schema);
  if (types !== undefined && !types.includes("array")) return [];
  if (schema.type !== undefined) return typedArrayItemTypes(schema);
  const branches = Array.isArray(schema.anyOf)
    ? schema.anyOf
    : Array.isArray(schema.oneOf)
      ? schema.oneOf
      : [];
  const itemTypes = branches.map(arrayItemTypes);
  return itemTypes.length > 0 && itemTypes.every((type) => type !== undefined)
    ? [...new Set(itemTypes.flat())]
    : undefined;
};

// Size constraints on the summarized instance itself. Required names stay
// with the properties they name: Gemini rejects required undeclared properties.
const summarizedConstraintKeys = [
  "minProperties",
  "maxProperties",
  "minItems",
  "maxItems",
] as const;

/**
 * Replace a nested schema with its accepted types, own size constraints and
 * guidance. The summary accepts every value the complete
 * schema accepts, so it only widens the advertisement; `items` appears only
 * beside the single `array` type.
 */
export const summarizedSchema = (
  schema: Readonly<Record<string, unknown>>,
): Record<string, unknown> => {
  const retained = {
    ...Object.fromEntries(
      summarizedConstraintKeys.flatMap((key) =>
        Object.hasOwn(schema, key) ? [[key, schema[key]]] : [],
      ),
    ),
    ...(typeof schema.description === "string"
      ? { description: schema.description }
      : {}),
  };
  const types = schemaTypes(schema);
  if (types === undefined) return retained;
  const others = types.filter((type) => type !== "array");
  if (others.length === types.length)
    return { type: typeKeyword(types), ...retained };
  const itemTypes = arrayItemTypes(schema);
  const array = {
    type: "array",
    items:
      itemTypes === undefined ||
      itemTypes.length === 0 ||
      itemTypes.includes("array")
        ? {}
        : { type: typeKeyword(itemTypes) },
  };
  return others.length === 0
    ? { ...array, ...retained }
    : { anyOf: [array, { type: typeKeyword(others) }], ...retained };
};

const withoutDescription = ({
  description: _description,
  ...schema
}: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> =>
  schema;

/**
 * Summarize a property whose nested schema repeats an earlier sibling's, such
 * as `after` beside `before`, as a pointer to that sibling. Records the first
 * occurrence of each nested schema in `complete`.
 */
const sharedSiblingSchema = (
  name: string,
  child: unknown,
  complete: [string, Readonly<Record<string, unknown>>][],
): Record<string, unknown> | undefined => {
  if (!isObject(child) || !hasNestedSchema(child)) return undefined;
  const shape = withoutDescription(child);
  const sibling = complete.find(([, known]) =>
    isDeepStrictEqual(withoutDescription(known), shape),
  )?.[0];
  if (sibling === undefined) {
    complete.push([name, child]);
    return undefined;
  }
  const shared = {
    ...summarizedSchema(child),
    description: [
      typeof child.description === "string" ? child.description : undefined,
      `Same schema as \`${sibling}\`.`,
    ]
      .filter((text) => text !== undefined)
      .join(" "),
  };
  return serializedBytes(shared) < serializedBytes(child) ? shared : undefined;
};

const isBooleanLiteralSchema = (schema: unknown): boolean =>
  isObject(schema) &&
  (typeof schema.const === "boolean" ||
    (Array.isArray(schema.enum) &&
      schema.enum.length > 0 &&
      schema.enum.every((value) => typeof value === "boolean")));

const isBooleanSchema = (schema: unknown): boolean =>
  isObject(schema) &&
  (schema.type === "boolean" || isBooleanLiteralSchema(schema));

const preserveSharedDefault = (
  schema: Record<string, unknown>,
  branches: readonly unknown[],
): void => {
  if (schema.default !== undefined) return;
  const defaults = branches
    .filter(isObject)
    .map((branch) => branch.default)
    .filter((value) => value !== undefined);
  if (
    defaults.length > 0 &&
    defaults.every((value) => isDeepStrictEqual(value, defaults[0]))
  )
    schema.default = defaults[0];
};

/**
 * Relax literal constraints that Gemini declarations reject, in place, without
 * rejecting a value the literal accepted. Returns whether anything changed.
 */
const relaxUnsupportedLiterals = (node: Record<string, unknown>): boolean => {
  let relaxed = false;
  if (typeof node.const === "boolean") {
    delete node.const;
    if (node.type === undefined) node.type = "boolean";
    relaxed = true;
  }
  if (node.const === "") {
    delete node.const;
    if (node.type === undefined) node.type = "string";
    relaxed = true;
  }
  if (
    Array.isArray(node.enum) &&
    node.enum.length > 0 &&
    node.enum.every((item) => typeof item === "boolean")
  ) {
    delete node.enum;
    if (node.type === undefined) node.type = "boolean";
    relaxed = true;
  }
  if (Array.isArray(node.enum) && node.enum.includes("")) {
    // Removing only the empty member would reject a canonical-valid input.
    // Gemini transports turn const into enum and refuse empty enum members.
    const values = node.enum;
    delete node.enum;
    if (
      node.type === undefined &&
      values.every((item) => typeof item === "string")
    )
      node.type = "string";
    relaxed = true;
  }
  if (typeof node.const === "number") {
    // Gemini accepts only string enum members, and transports turn const into
    // enum. The declared or literal numeric type still guides callers.
    const literal = node.const;
    delete node.const;
    if (node.type === undefined) node.type = literalType(literal);
    relaxed = true;
  }
  if (
    Array.isArray(node.enum) &&
    node.enum.some((item) => typeof item === "number")
  ) {
    const values = node.enum;
    delete node.enum;
    if (node.type === undefined)
      node.type = typeKeyword([...new Set(values.map(literalType))]);
    relaxed = true;
  }
  return relaxed;
};

const normalizeAdvertisedSchema = (
  value: unknown,
  summary?: SchemaSummary,
): SchemaNormalization => {
  if (!isObject(value)) return { schema: value, changed: false };
  if (summary !== undefined && summary.levels <= 0 && hasNestedSchema(value)) {
    // A summary can be longer than the schema it replaces, such as a nullable
    // array presented as anyOf. Keep the complete schema then.
    const summarized = summarizedSchema(value);
    return serializedBytes(summarized) < serializedBytes(value)
      ? { schema: summarized, changed: true }
      : normalizeAdvertisedSchema(value);
  }
  const nested = (key: string): SchemaSummary | undefined =>
    summary !== undefined && instanceChildKeys.has(key)
      ? { levels: summary.levels - 1 }
      : summary;

  const node: Record<string, unknown> = { ...value };
  let changed = false;
  const normalizeMap = (
    key: string,
    map: Readonly<Record<string, unknown>>,
  ) => {
    const complete: [string, Readonly<Record<string, unknown>>][] = [];
    return Object.fromEntries(
      Object.entries(map).map(([name, child]) => {
        const shared =
          summary !== undefined && key === "properties"
            ? sharedSiblingSchema(name, child, complete)
            : undefined;
        if (shared !== undefined) {
          changed = true;
          return [name, shared];
        }
        const result = normalizeAdvertisedSchema(child, nested(key));
        changed ||= result.changed;
        return [name, result.schema];
      }),
    );
  };
  const normalizeList = (key: string, list: readonly unknown[]) =>
    list.map((child) => {
      const result = normalizeAdvertisedSchema(child, nested(key));
      changed ||= result.changed;
      return result;
    });

  for (const [key, child] of Object.entries(value)) {
    if (schemaMaps.has(key) && isObject(child)) {
      node[key] = normalizeMap(key, child);
    } else if (
      schemaArrays.has(key) &&
      key !== "anyOf" &&
      key !== "oneOf" &&
      Array.isArray(child)
    ) {
      node[key] = normalizeList(key, child).map((result) => result.schema);
    } else if (
      schemaChildren.has(key) &&
      key !== "not" &&
      key !== "if" &&
      key !== "then" &&
      key !== "else"
    ) {
      const results = Array.isArray(child)
        ? normalizeList(key, child)
        : [normalizeAdvertisedSchema(child, nested(key))];
      const nestedChanged = results.some((result) => result.changed);
      if (
        key === "contains" &&
        nestedChanged &&
        value.maxContains !== undefined
      ) {
        delete node.contains;
        delete node.minContains;
        delete node.maxContains;
        changed = true;
      } else {
        node[key] = Array.isArray(child)
          ? results.map((result) => result.schema)
          : results[0]?.schema;
        changed ||= nestedChanged;
      }
    }
  }

  if (relaxUnsupportedLiterals(node)) changed = true;

  const negated = Object.hasOwn(value, "not")
    ? normalizeAdvertisedSchema(value.not, summary)
    : undefined;
  if (negated?.changed) {
    // Widening a predicate under `not` narrows the containing schema.
    changed = true;
    delete node.not;
  } else if (negated !== undefined) {
    node.not = negated.schema;
  }

  const conditional = Object.hasOwn(value, "if")
    ? normalizeAdvertisedSchema(value.if, summary)
    : undefined;
  const thenBranch = Object.hasOwn(value, "then")
    ? normalizeAdvertisedSchema(value.then, summary)
    : undefined;
  const elseBranch = Object.hasOwn(value, "else")
    ? normalizeAdvertisedSchema(value.else, summary)
    : undefined;
  if (conditional?.changed) {
    // Changing the predicate can route canonical-valid inputs into a rejecting branch.
    changed = true;
    delete node.if;
    delete node.then;
    delete node.else;
  } else {
    if (conditional !== undefined) node.if = conditional.schema;
    if (thenBranch !== undefined) {
      node.then = thenBranch.schema;
      changed ||= thenBranch.changed;
    }
    if (elseBranch !== undefined) {
      node.else = elseBranch.schema;
      changed ||= elseBranch.changed;
    }
  }

  for (const combinator of ["anyOf", "oneOf"] as const) {
    const branches = value[combinator];
    if (!Array.isArray(branches)) continue;
    const normalized = normalizeList(combinator, branches);
    const schemas = normalized.map((result) => result.schema);
    const branchesChanged = normalized.some((result) => result.changed);
    if (combinator === "oneOf" && branchesChanged) {
      const booleanLiteralsOnly = branches.every(isBooleanLiteralSchema);
      if (booleanLiteralsOnly) {
        node.type = "boolean";
        preserveSharedDefault(node, schemas);
        delete node.oneOf;
        changed = true;
        continue;
      }
      // `anyOf` retains branch guidance without allowing widened branches to
      // reject inputs that were accepted by exactly one canonical branch.
      delete node.oneOf;
      if (Array.isArray(node.anyOf)) {
        const existingAllOf = Array.isArray(node.allOf) ? node.allOf : [];
        node.allOf = [...existingAllOf, { anyOf: schemas }];
      } else {
        node.anyOf = schemas;
      }
      changed = true;
      continue;
    }
    if (
      branchesChanged &&
      schemas.length > 0 &&
      schemas.every(isBooleanSchema)
    ) {
      node.type = "boolean";
      preserveSharedDefault(node, schemas);
      delete node[combinator];
      changed = true;
      continue;
    }
    node[combinator] = schemas;
    changed ||= branchesChanged;
  }

  if (changed) {
    // A relaxed or summarized applicator can stop evaluating properties or
    // items, which these keywords would then reject.
    delete node.unevaluatedProperties;
    delete node.unevaluatedItems;
  }

  return { schema: node, changed };
};

// Anthropic tool input schemas reject anyOf, oneOf, and allOf at the root, and
// clients then drop the tool or advertise it without parameters. Present a
// root union of strict object groups as one object whose properties are the
// union of the groups. The canonical Zod schema still enforces the exact group.
const flattenRootObjectUnion = (
  root: Record<string, unknown>,
  references: JsonSchemaReferences,
): Record<string, unknown> => {
  const { anyOf, oneOf, ...rest } = root;
  const alternatives = Array.isArray(anyOf) ? anyOf : oneOf;
  if (
    !Array.isArray(alternatives) ||
    alternatives.length === 0 ||
    root.properties !== undefined
  )
    return root;
  // Lifting removes union locations and branch identities. References into those
  // locations, named anchors or unresolved bases cannot survive that rewrite.
  for (const { scope, target } of references.references())
    if (
      (target.kind === "unresolved" && target.reason === "dynamic") ||
      (scope === references.rootScope &&
        (target.kind !== "target" ||
          target.path.length === 0 ||
          target.path[0] === "anyOf" ||
          target.path[0] === "oneOf"))
    )
      return root;
  const branches = alternatives.map((branch) =>
    objectBranch(references, branch),
  );
  if (!branches.every((branch) => branch !== undefined)) return root;
  const variants = new Map<string, unknown[]>();
  for (const branch of branches)
    for (const [name, schema] of Object.entries(branch.properties ?? {})) {
      const known = variants.get(name) ?? [];
      if (!known.some((seen) => isDeepStrictEqual(seen, schema)))
        known.push(schema);
      variants.set(name, known);
    }
  const required = sharedRequiredProperties(branches);
  // A default lifted out of an input group can make a client send a field
  // rejected by another strict group. Keep it only when every group owns the
  // property and supplies the same default.
  for (const [name, schemas] of variants) {
    const defaults = branches.map((branch) => {
      const property = isObject(branch.properties)
        ? branch.properties[name]
        : undefined;
      return isObject(property) ? property.default : undefined;
    });
    if (
      defaults.every(
        (value) => value !== undefined && isDeepStrictEqual(value, defaults[0]),
      )
    )
      continue;
    const withoutDefaults: unknown[] = [];
    for (const schema of schemas) {
      let withoutDefault = schema;
      if (isObject(schema) && Object.hasOwn(schema, "default")) {
        const { default: _default, ...rest } = schema;
        withoutDefault = rest;
      }
      if (
        !withoutDefaults.some((known) =>
          isDeepStrictEqual(known, withoutDefault),
        )
      )
        withoutDefaults.push(withoutDefault);
    }
    variants.set(name, withoutDefaults);
  }
  // A coarse property minimum rejects underspecified objects. Partner fields
  // and exact group membership remain enforced by the canonical runtime parser.
  const fewestRequired = Math.min(
    ...branches.map((branch) => requiredProperties(branch).length),
  );
  // Groups that differ only in property values add no caller guidance.
  const groups = [...new Set(branches.map(inputGroup))];
  const description = [
    typeof rest.description === "string" ? rest.description : undefined,
    groups.length > 1
      ? `Provide a complete input group: ${groups.join("; ")}.`
      : undefined,
  ].filter((text) => text !== undefined);
  const {
    dependencies: _dependencies,
    dependentRequired: _dependentRequired,
    ...presentation
  } = rest;
  return {
    ...presentation,
    type: "object",
    ...(description.length > 0 ? { description: description.join(" ") } : {}),
    properties: Object.fromEntries(
      [...variants].map(([name, schemas]) => [
        name,
        schemas.length === 1 ? schemas[0] : { anyOf: schemas },
      ]),
    ),
    ...(required.length > 0 ? { required } : {}),
    ...(fewestRequired > 0 ? { minProperties: fewestRequired } : {}),
    ...(branches.every((branch) => branch.additionalProperties === false)
      ? { additionalProperties: false }
      : {}),
  };
};

/** Preserve opt-in discriminator relationships without a root union. */
const presentDiscriminatedRoot = (
  root: Record<string, unknown>,
): Record<string, unknown> => {
  const { "x-rea-root-discriminator": discriminator, ...canonical } = root;
  const references = new JsonSchemaReferences(canonical);
  const flattened = flattenRootObjectUnion(canonical, references);
  if (typeof discriminator !== "string" || flattened === canonical)
    return flattened;
  const alternatives = canonical.anyOf ?? canonical.oneOf;
  if (!Array.isArray(alternatives) || alternatives.length !== 2)
    throw new TypeError(
      "A presented root discriminator requires two object alternatives",
    );
  const branches = alternatives.map((alternative) => {
    const branch = objectBranch(references, alternative);
    if (branch === undefined || branch.additionalProperties !== false)
      throw new TypeError(
        "A presented root discriminator requires strict objects",
      );
    return branch;
  });
  const requiredBranch = branches.find((branch) =>
    requiredProperties(branch).includes(discriminator),
  );
  const fallback = branches.find(
    (branch) => !requiredProperties(branch).includes(discriminator),
  );
  const literal = (
    branch: Readonly<Record<string, unknown>> | undefined,
  ): unknown => {
    const properties = branch?.properties;
    const schema = isObject(properties) ? properties[discriminator] : undefined;
    return isObject(schema) ? schema.const : undefined;
  };
  const selected = literal(requiredBranch),
    otherwise = literal(fallback);
  if (
    requiredBranch === undefined ||
    fallback === undefined ||
    typeof selected !== "string" ||
    typeof otherwise !== "string" ||
    selected === otherwise
  )
    throw new TypeError(
      "A presented root discriminator requires distinct literals and one default alternative",
    );
  const properties = Object.fromEntries(
    Object.entries(
      isObject(flattened.properties) ? flattened.properties : {},
    ).map(([key, schema]) => {
      if (!isObject(schema) || !Array.isArray(schema.anyOf))
        return [key, schema];
      const possible = schema.anyOf.filter(
        (alternative) =>
          alternative !== false &&
          !(
            isObject(alternative) &&
            isObject(alternative.not) &&
            Object.keys(alternative.not).length === 0
          ),
      );
      return [key, possible.length === 1 ? possible[0] : schema];
    }),
  );
  const commonRequired = new Set(requiredProperties(flattened));
  const constraints = (branch: Readonly<Record<string, unknown>>) => {
    const own = isObject(branch.properties) ? branch.properties : {};
    const differences = Object.fromEntries(
      Object.entries(properties).flatMap(([key, schema]) => {
        if (key === discriminator || isDeepStrictEqual(schema, own[key]))
          return [];
        return [[key, Object.hasOwn(own, key) ? own[key] : false]];
      }),
    );
    const required = requiredProperties(branch).filter(
      (key) => !commonRequired.has(key),
    );
    return {
      ...(Object.keys(differences).length === 0
        ? {}
        : { properties: differences }),
      ...(required.length === 0 ? {} : { required }),
    };
  };
  // The canonical branch predicates supply validation; omit generic group
  // guidance that would describe the forbidden never-valued property as optional.
  const { description: _description, ...presentation } = flattened;
  return {
    ...presentation,
    properties,
    ...(canonical.description === undefined
      ? {}
      : { description: canonical.description }),
    if: {
      properties: { [discriminator]: { const: selected } },
      required: [discriminator],
    },
    then: constraints(requiredBranch),
    else: constraints(fallback),
  };
};

/** Describe canonical input fields and present the root as one object. */
export const presentInputJsonSchema = (
  root: Record<string, unknown>,
  describeProperty: (property: string) => string | undefined,
): Record<string, unknown> => {
  const flattened = presentDiscriminatedRoot(root);
  const references = new JsonSchemaReferences(flattened);
  const described = describeSchema(
    flattened,
    references,
    references.rootScope,
    describeProperty,
  );
  if (!isObject(described))
    return normalizeAdvertisedSchema(flattened).schema as Record<
      string,
      unknown
    >;
  const {
    dependencies: _dependencies,
    dependentRequired: _dependentRequired,
    ...presentation
  } = described;
  const rootDependencies = isObject(described.dependentRequired)
    ? described.dependentRequired
    : isObject(described.dependencies)
      ? described.dependencies
      : undefined;
  const dependencyGuidance =
    rootDependencies === undefined
      ? []
      : Object.entries(rootDependencies).flatMap(([property, partners]) =>
          Array.isArray(partners) &&
          partners.every((partner) => typeof partner === "string")
            ? [
                `When ${property} is provided, also provide ${partners.join(" and ")}.`,
              ]
            : [],
        );
  if (dependencyGuidance.length === 0)
    return normalizeAdvertisedSchema(presentation).schema as Record<
      string,
      unknown
    >;
  const description = [
    typeof presentation.description === "string"
      ? presentation.description
      : undefined,
    ...dependencyGuidance,
  ].filter((text) => text !== undefined);
  return normalizeAdvertisedSchema({
    ...presentation,
    description: description.join(" "),
  }).schema as Record<string, unknown>;
};

/**
 * Claude Desktop drops a local connector tool whose input schema, serialized
 * as compact JSON, exceeds 64 KiB (#4081). Other clients take the same
 * catalog, so every advertised input schema fits this limit.
 */
export const ADVERTISED_INPUT_SCHEMA_LIMIT_BYTES = 64 * 1024;

const SUMMARIZED_GUIDANCE =
  "Deeply nested and repeated inputs are advertised in summarized form to fit client schema-size limits; the server still validates complete canonical inputs.";

// The compact profile starts from the complete self-contained projection,
// not from a fitted summary of it.
const completeProjections = new WeakMap<object, Record<string, unknown>>();

/**
 * Return the input schema clients receive for the selected profile: the
 * fitted full advertisement, or the compact presentation of its complete
 * projection.
 */
export const presentAdvertisedInputProfile = (
  advertised: Record<string, unknown>,
  compactPresentation: CompactInputSchemaPresentation | undefined,
): Record<string, unknown> =>
  compactPresentation === undefined
    ? advertised
    : presentAdvertisedInputSchema(
        completeProjections.get(advertised) ?? advertised,
        compactPresentation,
      );

/**
 * Fit an advertised input schema within the client size limit. A schema that
 * already fits is returned unchanged. Otherwise identical sibling properties
 * point at the first one, and nested schemas below the deepest level that
 * still fits are summarized as their accepted types and guidance. Every
 * rewrite widens the advertisement, so canonical inputs and examples remain
 * accepted; the registered canonical schema still validates every call.
 */
export const fitAdvertisedInputSchema = (
  schema: Record<string, unknown>,
): Record<string, unknown> => {
  if (serializedBytes(schema) <= ADVERTISED_INPUT_SCHEMA_LIMIT_BYTES)
    return schema;
  // Summaries remove subschemas that a local reference could target.
  const references = new JsonSchemaReferences(schema).references();
  if (references.next().done !== true) return fitByCompaction(schema);
  const described = {
    ...schema,
    description: [
      typeof schema.description === "string" ? schema.description : undefined,
      SUMMARIZED_GUIDANCE,
    ]
      .filter((text) => text !== undefined)
      .join(" "),
  };
  // Size need not grow with the retained depth: a deeper candidate can be
  // smaller than a summary. Keep the deepest candidate that fits.
  for (let levels = schemaLevels(schema); levels >= 1; levels -= 1) {
    const candidate = summarizedInputSchemaCandidate(described, levels);
    if (serializedBytes(candidate) <= ADVERTISED_INPUT_SCHEMA_LIMIT_BYTES) {
      completeProjections.set(candidate, schema);
      return candidate;
    }
  }
  return fitByCompaction(schema);
};

/**
 * Advertise identical siblings as pointers and summarize schemas below the
 * given instance level. Exposed so tests can compare fitting candidates.
 */
export const summarizedInputSchemaCandidate = (
  schema: Record<string, unknown>,
  levels: number,
): Record<string, unknown> =>
  normalizeAdvertisedSchema(schema, { levels }).schema as Record<
    string,
    unknown
  >;

/** Fall back to the compact projection, which fits any budget. */
const fitByCompaction = (
  schema: Record<string, unknown>,
): Record<string, unknown> => {
  const { schema: fitted } = compactAdvertisedInputSchema(
    schema,
    ADVERTISED_INPUT_SCHEMA_LIMIT_BYTES,
  );
  completeProjections.set(fitted, schema);
  return fitted;
};
