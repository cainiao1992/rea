# Cross-layer JavaScript application workflows

REA derives a bounded feature trace from one authenticated JavaScript
Application Graph and compares two authenticated graph versions. The MCP tools
are `trace_application_feature`, `trace_javascript_semantics`,
`compare_application_versions`, `compare_source_to_bundle`, and
`compare_javascript_export_shapes`; their CLI equivalents use the same names
with hyphens.

Both workflows consume Evidence v2 produced by
`analyze_javascript_application` or `reconcile_javascript_runtime`. They do not
read an artifact, execute application code, attach to a process, or open a
native-analysis provider. Static artifact observations, passive runtime
observations, relationship inferences, and unknown or unavailable facts retain
their original graph authority.

Current `analyze_javascript_application` Evidence uses result schema v2. It
retains the structural JavaScript Application Graph and a separate semantic
relation graph bound to the same root artifact digest and structural graph ID.
Legacy v1 Evidence remains valid for structural workflows, but semantic tracing
returns an actionable request to reanalyze it rather than treating missing
semantic data as an empty graph.

## Feature tracing

Select one literal seed kind: node ID, route, string, API, IPC channel, module,
or native export. Matching is exact or literal substring matching; regular
expressions and executable predicates are not accepted. Direction, depth,
nodes, edges, paths, and seed matches all have caller-visible limits.

The result contains the matching basis, a bounded subgraph, terminal paths,
authority summaries, truncation frontier, and native handoffs. A handoff binds
the exact native artifact digest and requested exports from the application
graph. Existing Hopper or Ghidra Evidence is linked only when its subject digest
matches exactly. Otherwise the result recommends provider-neutral follow-up
tools and reports `requires-provider-analysis`; it never starts or switches a
provider implicitly.

## Semantic relation tracing

`trace_javascript_semantics` queries the authenticated companion graph without
rereading mutable files. A seed may identify a semantic or application node,
literal, function fingerprint, property, endpoint, event, or boundary field.
The query declares backward provenance, forward influence, callers, or
ownership and can restrict admitted relation kinds. Node, relation, depth,
function, module, seed-match, and page limits are validated against exact
published ranges. A committed cursor returns the next deterministic relation
page only for the same graph, query, and limits.

The extractor covers lexical definitions and reads, literal seeds, static
property slots, object reads/writes/spreads/destructuring, closure captures,
uniquely resolved local calls, argument/return flow, and explicit Promise
construction, chaining, aggregation, await, return, assignment, and
detachment. It also recovers bounded static candidates for EventEmitter
registrations/removals and dispatch, Node timers and cancellation handles, asynchronous
`node:child_process` creation and ownership, configuration sources and direct
defaults, request construction and response consumers, parse/coercion/
validation boundaries, and built-in resource acquisition/release.

Function fingerprints commit normalized syntax, control-flow shape, relation
shape, literal sets, arity, and detected effects without using local names or
source offsets. Equal duplicate fingerprints remain ambiguous. Dynamic
calls/properties/names, parser recovery, unresolved handles, unsupported API
shapes, and every reached bound stay explicit unknowns; a missing relation is
never reported as proven behavioral absence.

Semantic relations use static-inference authority. `resolved` means the static
target identity was unique within admitted analysis; it does not mean the path
executed. Candidate edges are excluded by default, require explicit opt-in, and
keep the result ambiguous. Runtime Evidence can later corroborate an exact
mapped candidate, but structural reachability, semantic influence, runtime
observation, and causal proof remain separate claims.

## Version comparison

REA pairs entities only when a tier produces one unique candidate on each side.
The tiers are exact content digest, exact module-source digest, exact node
identity, source-map identity, structural fingerprint, and a semantic key for
non-module entities. Lower tiers never override a higher unique match.

Module ordinals, stable minified names, and fuzzy text similarity are not
persistent identities. Duplicate candidates remain ambiguous. Source-map and
structural matches are high/medium-confidence inferences rather than exact
facts. Each item is `unchanged`, `added`, `removed`, `changed`, or `unknown`,
and the result includes its basis, candidates, changed dimensions, Evidence
links, limitations, and a bounded `changed_from` graph.

One-sided absence is `added` or `removed` only when the opposite input graph has
complete coverage. With partial, unavailable, or truncated input, the same
condition is `unknown`. Output truncation separately reports omitted comparison
items, candidate references, graph nodes, edges, and observations. With
`unknown_registry_approved: true`, unresolved comparison items can be retained
as a residual unknown in a live session.

## Historical source-to-bundle comparison

`compare_source_to_bundle` compares one cryptographically committed
`HistoricalSourceGraph/v1` with authenticated application-graph Evidence. The
stable scoring model reports every admitted signal and weight: exact source
digest, source-map original path, exact current path, path suffix, basename, and
language extension. Exact digest wins over location inference; weak basename
or extension evidence never forces a mapping.

Each historical source file is classified as `unchanged`, `modified`,
`removed`, `split`, `merged`, `duplicated`, or `unknown`. Multiple equally
scored path mappings form a bounded static split inference. Multiple current
nodes with the exact historical digest are duplicated; multiple historical
paths with exact identity to one current node are merged. `removed` requires
complete historical and application inventories with no relevant comparison
truncation. Ambiguous candidates, partial inventories, and exhausted limits
remain unknown. These static mappings do not claim runtime loading or semantic
equivalence.

## Export return-shape comparison

`compare_javascript_export_shapes` selects exactly one module path and export
name on each authenticated graph. Missing or duplicate exact selectors return
candidate inventory and an unknown result; the tool never chooses a fuzzy
match. An export is linked to a callable only through exact lexical/module
relationships recovered by the AST analysis.

Direct return expressions, including expression-bodied arrows, are evaluated
through a bounded execution-free value lattice. Literal object fields are
static observations. Calls, dynamic spreads, computed keys, parser recovery,
and exhausted value, property, or return-site limits remain partial or unknown.
Nested callable returns are not assigned to their parent callable. Projected
graph observations carry source ranges but never source text.

Return variants pair only when a literal discriminant such as `/type` has one
unique occurrence on each side and pairing is reciprocal. Changes use JSON
Pointer paths with `added`, `removed`, `changed`, or `unknown` status. A missing
field is added or removed only when the relevant parent-property coverage is
complete on both shapes. The output includes exact selector candidates,
omissions, Evidence links, coverage, limitations, and a separate controlled
replay recommendation; it does not execute JavaScript.

## CLI and verification

All five CLI commands accept inline JSON or a JSON file up to 64 MiB. The input
is the same object used by the corresponding MCP tool.

For two operator-provided directories or ASARs, run:

```bash
npm run verify:application-workflows -- \
  --left /absolute/path/to/version-a \
  --right /absolute/path/to/version-b \
  --source-map-read-approved
```

The verifier reconstructs both versions independently, compares them, runs one
literal trace when a seed is available, and compares the first common exact
export return shape when present. It prints only graph, artifact, and Evidence
identifiers plus matching, changes, summary, handoff, and coverage statistics;
it does not print source text. Use `--seed-kind` and `--seed-value` to select a
specific route, string, API, channel, module, native export, or node ID. Supply
all four `--left-module-path`, `--left-export-name`, `--right-module-path`, and
`--right-export-name` options to verify an explicit export pair.

Because source Evidence and derived Evidence are retained by the normal session
ledger, evidence bundles, analysis snapshots, and investigation workspaces can
carry these records without another persistence format.

## Controlled replay boundary

Static graph workflows never execute a graph node or recovered module.
`run_controlled_replay` is the separate extracted-module boundary: it requires
the `javascript_replay` authority, a plan call followed by exact content-bound
approval, and the mandatory Linux OS sandbox fixed by
[ADR-0002](adr/0002-controlled-replay-authority-and-sandbox.md). Browser,
Electron, Process Capture, artifact-read, and static-analysis approvals do not
authorize that execution.

Replay observations retain `controlled-replay` authority. They cannot
promote static inference into passive runtime observation or prove that the
original application, renderer, preload, main process, or remote service
behaved identically.
