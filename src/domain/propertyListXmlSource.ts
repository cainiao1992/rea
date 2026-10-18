import type { Document, Node } from "@xmldom/xmldom";
import { MAX_PLIST_DEPTH } from "./apple/plistValue.js";
import { err, ok, type Result } from "./result.js";
import { parseXmlDocument } from "./xmlDocument.js";
import {
  decodeXmlPlistData,
  XmlPlistDataError,
} from "./propertyListXmlData.js";

// Preserve the established XML decoder normalization; keep raw data separately.
const LINE_ENDING = /\r[\n\u0085]|[\r\n\u0085\u2028\u2029]/gu;

interface DataSpan {
  readonly start: number;
  readonly end: number;
}

/** One source owner binds lexical data values to their validated DOM nodes. */
export const readXmlPlistSource = (text: string) => {
  const normalized = text.replace(LINE_ENDING, "\n");
  const parsed = parseXmlDocument(normalized, {
    doctype: "allow",
    lineEndings: "preserve",
  });
  if (!parsed.ok) throw parsed.error;
  const document = parsed.value;
  const lineEndings = new RegExp(LINE_ENDING);
  let line = 1;
  let lineStart = 0;
  // The depth walk visits elements in source order, so location lookup is
  // linear without an index entry for every line in a potentially large value.
  const readData = (
    node: Node,
  ): Result<DataSpan, XmlPlistDataError["reason"]> => {
    if (node.lineNumber === undefined || node.columnNumber === undefined)
      return err("source-location");
    while (line < node.lineNumber) {
      const ending = lineEndings.exec(text);
      if (ending === null) return err("source-location");
      lineStart = ending.index + ending[0].length;
      line += 1;
    }
    if (line !== node.lineNumber) return err("source-location");
    for (let child = node.firstChild; child !== null; child = child.nextSibling)
      if (child.nodeType !== child.TEXT_NODE) return err("markup");
    const start = lineStart + node.columnNumber - 1;
    const openingEnd = openingTagEnd(text, start);
    if (openingEnd < 0) return err("source-location");
    if (text[openingEnd - 1] === "/") return err("empty-element");
    const end = text.indexOf("<", openingEnd + 1);
    if (end < 0) return err("source-location");
    return ok({ start: openingEnd + 1, end });
  };
  const data = collectXmlPlistDataSpans(document, readData);
  return {
    document,
    dataValue(node: Node): Result<Uint8Array, XmlPlistDataError> {
      const span = data.get(node);
      if (span === undefined)
        return err(new XmlPlistDataError("source-location"));
      return span.ok
        ? decodeXmlPlistData(text.slice(span.value.start, span.value.end))
        : err(new XmlPlistDataError(span.error));
    },
  };
};

/** The validated DOM omits the distinction between <data/> and <data></data>. */
const openingTagEnd = (source: string, start: number): number => {
  let quote: string | undefined;
  for (let cursor = start; cursor < source.length; cursor += 1) {
    const character = source[cursor];
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
    } else if (character === '"' || character === "'") quote = character;
    else if (character === ">") return cursor;
  }
  return -1;
};

/** Elements whose children the plist value decoder visits recursively. */
const PLIST_CONTAINER_ELEMENTS = new Set(["plist", "dict", "array"]);

/**
 * Reject XML plists nested deeper than the projection supports before any
 * recursive value pass runs. Value decoding and prototype omission recurse once
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
const collectXmlPlistDataSpans = (
  document: Document,
  readData: (node: Node) => Result<DataSpan, XmlPlistDataError["reason"]>,
): WeakMap<Node, Result<DataSpan, XmlPlistDataError["reason"]>> => {
  const data = new WeakMap<
    Node,
    Result<DataSpan, XmlPlistDataError["reason"]>
  >();
  const root = document.documentElement;
  if (root === null) return data;
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
    if (node.nodeName === "data") data.set(node, readData(node));
    if (PLIST_CONTAINER_ELEMENTS.has(node.nodeName) && node.firstChild !== null)
      pending.push({ node: node.firstChild, depth: depth + 1 });
  }
  return data;
};
