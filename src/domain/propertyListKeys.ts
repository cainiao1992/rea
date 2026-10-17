import { normalizeLineEndings, type Document, type Node } from "@xmldom/xmldom";
import { parse, parseOpenStep } from "plist";

import { MAX_PLIST_DEPTH } from "./apple/plistValue.js";
import { parseXmlDocument } from "./xmlDocument.js";

/** The dictionary key REA results cannot carry: validation strips it. */
const PROTOTYPE_KEY = "__proto__";

/** A decoded plist without `__proto__` entries, and how many were omitted. */
export interface PropertyListWithoutPrototypeKeys {
  readonly value: unknown;
  readonly omittedPrototypeKeys: number;
}

/** Limitation for results whose source plist held `__proto__` entries. */
export const omittedPrototypeKeysLimitation = (count: number | null): string =>
  count === null
    ? "Dictionary entries keyed __proto__ were omitted because REA results cannot represent that key."
    : `${String(count)} dictionary ${count === 1 ? "entry" : "entries"} keyed __proto__ ${count === 1 ? "was" : "were"} omitted because REA results cannot represent that key.`;

const projectDictionaryKeys = (
  value: unknown,
  projectName: (name: string) => string | undefined,
): PropertyListWithoutPrototypeKeys => {
  let omitted = 0;
  const strip = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(strip);
    if (
      item === null ||
      typeof item !== "object" ||
      item instanceof Date ||
      item instanceof Uint8Array
    )
      return item;
    return Object.fromEntries(
      Object.entries(item).flatMap(([name, entry]) => {
        const projected = projectName(name);
        if (projected !== undefined) return [[projected, strip(entry)]];
        omitted += 1;
        return [];
      }),
    );
  };
  const stripped = strip(value);
  return { value: stripped, omittedPrototypeKeys: omitted };
};

/** Remove own `__proto__` entries, such as JSON.parse creates, and count them. */
export const omitPrototypeKeys = (
  value: unknown,
): PropertyListWithoutPrototypeKeys =>
  projectDictionaryKeys(value, (name) =>
    name === PROTOTYPE_KEY ? undefined : name,
  );

const XML_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  quot: '"',
};

/**
 * Expand XML character and predefined entity references. A reference beyond
 * Unicode stays as written: comments and CDATA may hold such text literally,
 * and the XML decoder rejects it anywhere else.
 */
export const decodeXmlText = (text: string): string =>
  text.replace(
    /&(?:#x([\da-f]+)|#(\d+)|([a-z]+));/giu,
    (entity, hex?: string, decimal?: string, name?: string) => {
      const codePoint =
        hex !== undefined
          ? parseInt(hex, 16)
          : decimal !== undefined
            ? parseInt(decimal, 10)
            : undefined;
      if (codePoint !== undefined)
        return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : entity;
      return name !== undefined && Object.hasOwn(XML_ENTITIES, name)
        ? XML_ENTITIES[name]!
        : entity;
    },
  );

/**
 * Decode complete XML character-data keys before the pinned value decoder.
 * Entries keyed `__proto__` are omitted and counted at the same boundary.
 */
export const parseXmlPropertyList = (
  text: string,
): PropertyListWithoutPrototypeKeys => {
  // Preserve the pinned decoder's existing OpenStep autodetection, also used
  // by app Info.plist resolution. Only XML needs key normalization.
  const first = text.trimStart()[0];
  if (first === "{" || first === "(") {
    // The pinned decoder assigns a `__proto__` key to the object prototype, so
    // the entry is gone before the decoded value can be counted. Count keys in
    // the source instead; the rebuild still drops any prototype it replaced.
    const prototypeKeys = scanOpenStep(text);
    return {
      value: omitPrototypeKeys(parse(text)).value,
      omittedPrototypeKeys: prototypeKeys,
    };
  }
  // Normalize only the literal line endings the pinned decoder normalizes.
  // Preserve character references in the source: serializing a DOM would turn
  // e.g. an encoded carriage return into a literal newline on the second parse.
  const normalized = normalizeLineEndings(text);
  // Validate before plist's recovering XML decoder can turn malformed source
  // into observed values. Reuse the validated DOM for depth and key ownership.
  const parsed = parseXmlDocument(normalized, {
    doctype: "allow",
    lineEndings: "preserve",
  });
  if (!parsed.ok) throw parsed.error;
  const document = parsed.value;
  assertXmlPlistDepthWithinLimit(document);
  const { substituted, names } = normalizeXmlKeys(normalized, document);
  return projectDictionaryKeys(parse(substituted), (name) => {
    const decoded = names.get(name) ?? name;
    return decoded === PROTOTYPE_KEY ? undefined : decoded;
  });
};

interface OpenStepContainer {
  end: string;
  next: "key" | "equals" | "value" | "separator" | "after-value";
  /** Source offset of a container that is itself a dictionary key. */
  keyStart?: number;
}

/** Consume only the punctuation expected between the pinned decoder's values. */
const consumeOpenStepSeparator = (
  parent: OpenStepContainer | undefined,
  character: string,
): "consumed" | "invalid" | "none" => {
  if (parent?.next === "after-value") {
    parent.next = "key";
    return character === ";" ? "consumed" : "none";
  }
  if (parent?.next !== "equals" && parent?.next !== "separator") return "none";
  if (character !== (parent.next === "equals" ? "=" : ",")) return "invalid";
  parent.next = "value";
  return "consumed";
};

/** An array may close after a comma; a dictionary still needs its assigned value. */
const admitsOpenStepCloser = (
  parent: OpenStepContainer | undefined,
  character: string,
): boolean =>
  parent?.end === character &&
  parent.next !== "equals" &&
  !(parent.end === "}" && parent.next === "value");

/**
 * Bound OpenStep value nesting before the pinned decoder recursively reads it,
 * and count the dictionary keys that decode to `__proto__`.
 */
const scanOpenStep = (text: string): number => {
  let prototypeKeys = 0;
  const containers: OpenStepContainer[] = [];
  const completeValue = (): void => {
    const parent = containers.at(-1);
    if (parent !== undefined)
      parent.next =
        parent.next === "key"
          ? "equals"
          : parent.end === "}"
            ? "after-value"
            : "separator";
  };
  const assertDepth = (): void => {
    if (containers.length > MAX_PLIST_DEPTH)
      throw new RangeError(
        `Plist exceeds ${String(MAX_PLIST_DEPTH)} nesting levels`,
      );
  };
  let cursor = 0;
  while (cursor < text.length) {
    const afterTrivia = skipOpenStepTrivia(text, cursor);
    if (afterTrivia !== cursor) {
      cursor = afterTrivia;
      continue;
    }
    const character = text[cursor] ?? "";
    const parent = containers.at(-1);
    // Stop at the first impossible token: only the pinned decoder owns syntax
    // diagnostics. A later deep suffix cannot change that failure into a limit.
    if (character === "}" || character === ")") {
      if (!admitsOpenStepCloser(parent, character)) return prototypeKeys;
      const closed = containers.pop();
      if (
        closed?.keyStart !== undefined &&
        isOpenStepPrototypeKey(text.slice(closed.keyStart, cursor + 1))
      )
        prototypeKeys += 1;
      // parseOpenStep returns the first root value without reading trailing text.
      if (containers.length === 0) return prototypeKeys;
      completeValue();
      cursor += 1;
      continue;
    }
    const separator = consumeOpenStepSeparator(parent, character);
    if (separator === "invalid") return prototypeKeys;
    if (separator === "consumed") {
      cursor += 1;
      continue;
    }
    if (character === "{" || character === "(") {
      assertDepth();
      containers.push({
        end: character === "{" ? "}" : ")",
        next: character === "{" ? "key" : "value",
        // A compound key is coerced to a string, e.g. `(__proto__)`.
        ...(parent?.next === "key" ? { keyStart: cursor } : {}),
      });
      cursor += 1;
      continue;
    }
    const end = skipOpenStepScalar(text, cursor);
    if (end === cursor) return prototypeKeys;
    if (parent?.next === "key") {
      if (isOpenStepPrototypeKey(text.slice(cursor, end))) prototypeKeys += 1;
    } else assertDepth();
    cursor = end;
    completeValue();
  }
  return prototypeKeys;
};

/**
 * Whether one OpenStep key, scalar or compound, becomes the property name
 * `__proto__` when the decoder assigns `obj[key]`. Plain strings compare
 * directly; any other key is decoded by the pinned decoder itself and
 * coerced to a property name the same way that assignment does.
 */
const isOpenStepPrototypeKey = (token: string): boolean => {
  if (!/^["({<]/u.test(token)) return token === PROTOTYPE_KEY;
  if (token.startsWith('"') && !token.includes("\\"))
    return token === `"${PROTOTYPE_KEY}"`;
  try {
    return String(parseOpenStep(token)) === PROTOTYPE_KEY;
  } catch {
    // An unterminated token is the decoder's syntax error to report.
    return false;
  }
};

/** Skip grammar trivia without interpreting delimiter examples inside comments. */
const skipOpenStepTrivia = (text: string, cursor: number): number => {
  if (/\s/u.test(text[cursor] ?? "")) return cursor + 1;
  if (!text.startsWith("//", cursor) && !text.startsWith("/*", cursor))
    return cursor;
  const line = text[cursor + 1] === "/";
  const end = text.indexOf(line ? "\n" : "*/", cursor + 2);
  return end === -1 ? text.length : end + (line ? 1 : 2);
};

/** Read the extent of one opaque scalar; the pinned decoder still owns its value. */
const skipOpenStepScalar = (text: string, start: number): number => {
  let cursor = start;
  const character = text[cursor];
  if (character === '"') {
    cursor += 1;
    while (cursor < text.length) {
      const next = text[cursor];
      cursor += next === "\\" ? 2 : 1;
      if (next === '"') break;
    }
  } else if (character === "<") {
    const end = text.indexOf(">", cursor + 1);
    cursor = end === -1 ? text.length : end + 1;
  } else {
    // Match the pinned OpenStep decoder's unquoted-string alphabet. Other
    // syntax remains for the decoder to reject; preflight only owns depth.
    while (
      cursor < text.length &&
      /[a-zA-Z0-9._/$:-]/u.test(text[cursor] ?? "")
    )
      cursor += 1;
  }
  return cursor;
};

/** Elements whose children the pinned plist value decoder visits recursively. */
const PLIST_CONTAINER_ELEMENTS = new Set(["plist", "dict", "array"]);

/**
 * Reject XML plists nested deeper than the projection supports before any
 * recursive value pass runs. `plist` and the prototype-key traversal recurse once
 * per nesting level, so a deeply nested document exhausts the call stack
 * before the projection limit can report the resource bound. The failure
 * matches `projectPlistValue` so callers classify it as a limit failure.
 *
 * Depth counts values the way the projection does: the root value is level 0
 * and every container member is one level deeper. A dictionary key names a
 * member instead of nesting one, and a self-closing element is the value at
 * its own level. The outer plist envelope is unwrapped by the decoder;
 * nested plist elements decode as arrays and must count toward the bound.
 */
const assertXmlPlistDepthWithinLimit = (document: Document): void => {
  const root = document.documentElement;
  if (root === null) return;
  const pending: Array<{ node: Node; depth: number }> = [
    { node: root, depth: -1 },
  ];
  while (pending.length > 0) {
    const entry = pending.pop();
    if (entry === undefined) break;
    const { node, depth } = entry;
    // Schedule only the next sibling, keeping traversal storage proportional
    // to depth rather than the number of members in a wide container.
    if (node.nextSibling !== null)
      pending.push({ node: node.nextSibling, depth });
    if (node.nodeType !== node.ELEMENT_NODE) continue;
    if (node.nodeName !== "key" && depth > MAX_PLIST_DEPTH)
      throw new RangeError(
        `Plist exceeds ${String(MAX_PLIST_DEPTH)} nesting levels`,
      );
    if (PLIST_CONTAINER_ELEMENTS.has(node.nodeName) && node.firstChild !== null)
      pending.push({ node: node.firstChild, depth: depth + 1 });
  }
};

/** The validated DOM owns key identities; aliases bypass first-child-only decoding. */
const normalizeXmlKeys = (text: string, document: Document) => {
  const keys = Array.from(document.getElementsByTagName("key"))
    // The decoder also accepts <key> as a scalar outside dictionaries. Such
    // values have no dictionary-name restoration boundary and must not alias.
    .filter((key) => key.parentNode?.nodeName === "dict")
    .map((key) => {
      const first = key.firstChild;
      // Nested elements are unsupported key markup. Retain the pinned decoder's
      // interpretation instead of treating descendant element text as key data.
      const characterDataOnly = !Array.from(key.childNodes).some(
        (child) => child.nodeType === child.ELEMENT_NODE,
      );
      return {
        node: first ?? key,
        empty: first === null,
        name: characterDataOnly
          ? (key.textContent ?? "")
          : first === null
            ? ""
            : String(first.nodeValue),
        firstName: first?.nodeValue ?? "",
      };
    });
  const occupied = new Set(
    keys.flatMap(({ name, firstName }) => [name, firstName]),
  );
  const aliases = new Map<string, string>();
  const names = new Map<string, string>();
  for (const { name, firstName } of keys) {
    if ((name !== PROTOTYPE_KEY && name === firstName) || aliases.has(name))
      continue;
    let alias = `__rea_plist_key_${String(aliases.size)}__`;
    while (occupied.has(alias)) alias = `_${alias}`;
    occupied.add(alias);
    aliases.set(name, alias);
    names.set(alias, name);
  }
  // Alias every occurrence of a corrected name, including plain spellings,
  // so the decoder retains its last-value-wins behavior for duplicate keys.
  const replacements = keys.filter(({ name }) => aliases.has(name));
  if (replacements.length === 0) return { substituted: text, names };

  // xmldom uses one-based locators in document order. Scan forward only to
  // needed lines instead of retaining an offset for every source newline.
  let line = 1;
  let lineStart = 0;
  const parts: string[] = [];
  let cursor = 0;
  for (const { node, name, empty } of replacements) {
    const nodeLine = node?.lineNumber;
    const column = node?.columnNumber;
    if (nodeLine === undefined || column === undefined)
      throw new TypeError("XML plist key has no source location");
    while (line < nodeLine) {
      const newline = text.indexOf("\n", lineStart);
      if (newline === -1)
        throw new TypeError("XML plist key has an invalid source location");
      lineStart = newline + 1;
      line += 1;
    }
    const offset = lineStart + column - 1;
    const marker = `<![CDATA[${aliases.get(name)}]]>`;
    parts.push(text.slice(cursor, offset));
    if (empty) {
      // Empty keys have no child locator. Replace only their opening tag,
      // consuming quoted attributes whole, and expand self-closing spellings.
      const opening = /^<(?:[^>"']|"[^"]*"|'[^']*')*>/u.exec(
        text.slice(offset),
      )?.[0];
      if (opening === undefined)
        throw new TypeError("XML plist key has an invalid opening tag");
      parts.push(
        /\/\s*>$/u.test(opening)
          ? `${opening.replace(/\/\s*>$/u, ">")}${marker}</key>`
          : `${opening}${marker}`,
      );
      cursor = offset + opening.length;
    } else {
      parts.push(marker);
      cursor = offset;
    }
  }
  parts.push(text.slice(cursor));
  return { substituted: parts.join(""), names };
};
