# Process trace validation

A 6,000-event directed cycle previously overflowed the JavaScript stack inside
the schema refinement. Cycle detection now uses iterative topological traversal.
Reachability is computed once per queried origin; cyclic inputs retain
independent declaration diagnostics without expanding all event pairs. Unordered
declarations retain group membership, with one diagnostic per overlapping group,
instead of allocating a pair set and repeating the same error for every pair.
Valid partial orders still receive complete pair validation.

## Bounded comparison

Flameox ran three randomized paired blocks (seed 917), each limited to 20 seconds
and 512 MiB. Node 24.18.0 used a 384-MiB old-space limit on macOS arm64. Each
process validated the same 2,500-event acyclic chain four times, then checked the
known 6,000-event cycle failure with per-event not-before constraints and one
unordered group containing every event. All six executions passed the embedded answer
digest and expected rejection checks.

The baseline source is from `bb540826d`; the candidate includes this trace fix.
Both modules had TypeScript annotations removed with Node's identical built-in
transform and used the same copied runtime dependencies. This isolates schema
validation rather than comparing complete packaged CLI/MCP processes.

| Median measurement                           | Baseline | Candidate |
| -------------------------------------------- | -------: | --------: |
| First validation elapsed milliseconds        |   335.80 |    177.25 |
| Warm validation elapsed milliseconds         |   313.36 |    165.23 |
| First validation CPU milliseconds            |   366.85 |    218.39 |
| Warm validation CPU milliseconds             |   335.32 |    194.08 |
| Whole-process elapsed milliseconds           | 1,344.13 |    787.00 |
| Process CPU milliseconds before final report | 1,457.67 |    941.05 |
| Peak process-family MiB                      |   328.36 |    395.52 |

The input is identical: 233,095 JSON bytes, estimated at 77,010 tokens by tokenx
1.3.0. The valid parsed result digest is
`28bd99ce83f0da8e45600ef20f114cb52bb26b5f5e6bfc1601ca3e712eaf3147`.
Actual agent tokens, catalog injection, transport, model reasoning and provider
costs were not measured. This is a component measurement, not an end-to-end
investigation speed claim.

First validation excludes module import and fixture preparation; warm runs reuse
the process but create fresh per-validation graph state. Whole-process elapsed
includes startup, imports, all four validations, the cyclic-input check, token
estimation and reporting. CPU includes startup through metrics publication;
peak RSS covers the complete single-process workload, with no children. Host
caches were not flushed. Peak memory increased in this cohort. The remaining
valid-order closure and pair validation can still require quadratic resources.
Three pairs describe this fixture only.

Preserved Flameox evidence:
`d6211639446e8b6ec2e82636913eaf471def96673e28f03e9c7f98bec07f8e13`;
analysis `e663b6bd8f5693975542d5b5e2b18437b3c167a0be939bb7386eb68549936231`.
An earlier cohort lost modules during another checkout build; its three failed
executions and timing results are excluded. The successful cohort uses an
isolated runtime copy. Source-module SHA-256 values are
`a7729faa2183b0e493b9ac4fc55f6feaee5b2e5294be13d1b29b57a44b899788`
(baseline) and `725409ce84902125941251037a8a214ccc3c1eec577e484c164c361ca580d693`
(candidate).
