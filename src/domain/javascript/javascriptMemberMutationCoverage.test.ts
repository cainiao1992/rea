import { expect, it } from "vitest";
import {
  analyzeJavaScriptSemantics,
  indexJavaScriptBindingsWithReceiversSteps,
} from "./javascriptSemanticAnalysis.js";
import { onlyCallable } from "./javascriptSemanticAnalysis.fixture.js";
import { semanticResourceLimitReason } from "./javascriptSemanticResourceLimits.js";
import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";
import { completeSemanticSteps } from "./javascriptSemanticTraversal.js";

import {
  joinSemanticPropertyPaths,
  semanticPropertyPathKeyMatches,
} from "./javascriptSemanticPropertyPaths.js";

const resultValue = (body: string) =>
  onlyCallable(
    analyzeJavaScriptSemantics(`export function result() { ${body} }`),
    "result",
  ).returnSites[0]?.value;

it("retains common copy exclusions and the union of array prefixes", () => {
  const path = joinSemanticPropertyPaths(
    [{ excludedKeys: ["1", "2"], startIndex: 1 }],
    [{ excludedKeys: ["2", "3"], startIndex: 2 }],
  );
  const key = path?.[0];
  if (key === undefined) throw new Error("Expected joined projection");
  expect(
    ["0", "1", "2", "3", "4", "named"].filter((name) =>
      semanticPropertyPathKeyMatches(key, name),
    ),
  ).toEqual(["1", "3", "4"]);
  const withScalar = joinSemanticPropertyPaths(path ?? [], [0]);
  const scalarKey = withScalar?.[0];
  if (scalarKey === undefined) throw new Error("Expected joined scalar");
  expect(
    ["0", "1", "2", "3", "named"].filter((name) =>
      semanticPropertyPathKeyMatches(scalarKey, name),
    ),
  ).toEqual(["0", "1", "3"]);
  const exact = [1] as const;
  expect(joinSemanticPropertyPaths(exact, ["1"])).toBe(exact);
});

const memberAliasSource = (count: number) => `
  import { Worker } from "node:worker_threads";
  const alias0 = globalThis;
  ${Array.from(
    { length: count },
    (_, index) =>
      `const alias${index + 1} = flag${index} ? alias${index}.globalThis : alias${index}.window;`,
  ).join("\n")}
  alias${count}.URL = replacement;
  new Worker(new URL("./worker.js", import.meta.url));
`;

it("joins overflowing member-alias histories into disclosed possible effects", () => {
  const source = memberAliasSource(16);
  const ir = analyzeJavaScriptSemantics(source);
  expect(ir.coverage).toMatchObject({
    status: "partial",
    omittedCount: null,
    resourceLimits: ["alias-selections"],
  });
  expect(ir.limitations).toContain(
    semanticResourceLimitReason("alias-selections"),
  );
  const facts = analyzeJavaScriptStaticSource(source);
  expect(facts.limitations).toContain(
    semanticResourceLimitReason("alias-selections"),
  );
  expect(
    facts.references.filter(({ kind }) => kind === "worker"),
  ).toMatchObject([{ specifier: null }]);
});

it("never records a joined selector as a definite receiver replacement", () => {
  const parsed = parseJavaScriptSource(memberAliasSource(16));
  if (parsed === null) throw new Error("Expected parsed source");
  const index = completeSemanticSteps(
    indexJavaScriptBindingsWithReceiversSteps(parsed.program),
  );
  completeSemanticSteps(index.indexMemberMutationFactsSteps());
  const joined = [...index.bindings.bindingsById.values()]
    .flatMap(({ memberWrites }) => memberWrites)
    .filter(({ path }) => path.includes(null));
  expect(joined.length).toBeGreaterThan(0);
  expect(
    joined.every(({ receiverIdentity }) => receiverIdentity === "possible"),
  ).toBe(true);
});

it("keeps small selector alternatives exact and preserves an untouched third sibling", () => {
  const ir = analyzeJavaScriptSemantics(`
    export function result() {
      const source = { left: { value: 1 }, right: { value: 3 }, third: { value: 2 } };
      const selected = flag ? source.left : source.right;
      selected.value = replacement;
      return source.third.value;
    }
  `);
  expect(onlyCallable(ir, "result").returnSites[0]?.value).toEqual({
    status: "literal",
    value: 2,
  });
  expect(ir.coverage.resourceLimits ?? []).not.toContain("alias-selections");
});

it.each([
  "const left={value:1}; const right={value:2}; const window={left,right}; const selected=flag?window.left:window.right; selected.value=9; return left.value;",
  "const left={value:1}; const right={value:2}; const globalThis={window:left,globalThis:right}; const selected=flag?globalThis.window:globalThis.globalThis; selected.value=9; return left.value;",
  "const local={value:1}; const selected=flag?local:external; selected.value=9; return local.value;",
])("retains local and unresolved mutation targets: %s", (body) => {
  expect(resultValue(body)?.status).toBe("unknown");
});

it.each(["first", "second"])(
  "retains both captured targets across replacement: %s",
  (name) => {
    expect(
      resultValue(`
      const first = { value: 1 };
      const second = { value: 2 };
      let current = first;
      const before = current;
      current = second;
      const after = current;
      const selected = flag ? before : after;
      selected.value = 9;
      return ${name}.value;
    `)?.status,
    ).toBe("unknown");
  },
);

it.each([
  "const first={value:1}; const second={value:2}; const captured=first; let selected=first; selected=second; const alias=flag?captured:captured; alias.value=9; return second.value;",
  "const first={value:2}; const second={value:1}; let selected=first; selected=second; const captured=selected; const alias=flag?captured:captured; alias.value=9; return first.value;",
  "const source={left:{value:1},right:{value:2}}; source.left.value=9; return source.right.value;",
])("preserves captured ownership and unjoined siblings: %s", (body) => {
  expect(resultValue(body)).toEqual({ status: "literal", value: 2 });
});

it("preserves exclusions shared by shallow-copy alternatives", () => {
  expect(
    resultValue(`
    const excluded = { value: 2 };
    const first = { value: 1 };
    const second = { value: 3 };
    const source = { excluded, first, second };
    const { excluded: leftExcluded, first: leftFirst, ...left } = source;
    const { excluded: rightExcluded, second: rightSecond, ...right } = source;
    const selected = flag ? left : right;
    mutate(selected);
    return excluded.value;
  `),
  ).toEqual({ status: "literal", value: 2 });
});

it("keeps a preceding global self-property replacement unresolved", () => {
  const facts = analyzeJavaScriptStaticSource(`
    import { Worker } from "node:worker_threads";
    globalThis.window = replacement;
    const selected = flag ? globalThis.window : globalThis;
    selected.URL = replacement;
    new Worker(new URL("./worker.js", import.meta.url));
  `);
  expect(
    facts.references.filter(({ kind }) => kind === "worker"),
  ).toMatchObject([{ specifier: null }]);
});
