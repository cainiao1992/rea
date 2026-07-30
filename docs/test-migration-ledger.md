# Test architecture migration ledger

This ledger records how the flat test suite was classified during the
coordinated architecture cutover. It is an evidence index, not a declaration
that every test became independent merely because its path changed.

## Classification batches

The following mappings are grounded in the current moved paths. They describe
ownership only; decomposition and evidence replacement must be recorded in the
per-suite table below.

| Previous path                                                                                       | Current path                                                                     | Classification                      |
| --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------- |
| `tests/applicationWorkflowCli.test.ts`                                                              | `tests/acceptance/applications/applicationWorkflowCli.test.ts`                   | Acceptance application workflow     |
| `tests/setupLifecycle.test.ts`                                                                      | `tests/acceptance/setup/setupLifecycle.test.ts`                                  | Acceptance setup workflow           |
| `tests/cdpBrowserProvider.test.ts`                                                                  | `tests/boundary/browser/cdpBrowserProvider*.test.ts`                             | Browser boundary                    |
| `tests/ghidraClient.test.ts`                                                                        | `tests/boundary/providers/ghidra/ghidraClient.test.ts`                           | Ghidra provider boundary            |
| `tests/processOwnership.test.ts`                                                                    | `tests/boundary/process/processOwnership*.test.ts`                               | Process boundary                    |
| `tests/binarySession.test.ts`                                                                       | `tests/composition/analysis-sessions/binarySession.*.test.ts`                    | Analysis-session composition        |
| `tests/javascriptSemanticAnalysis.test.ts`                                                          | `tests/composition/javascript-applications/javascriptSemanticAnalysis.*.test.ts` | JavaScript-application composition  |
| `tests/config.test.ts`                                                                              | `tests/composition/setup-lifecycle/config.test.ts`                               | Setup-lifecycle composition         |
| `tests/composition/analysis-sessions/runtime.test.ts`                                               | `tests/acceptance/applications/runtime.test.ts`                                  | Compiled MCP acceptance workflow    |
| `tests/conformanceFixtures.test.ts`                                                                 | `tests/conformance/providers/conformanceFixtures.test.ts`                        | Provider conformance                |
| `tests/codexAgentEval.test.ts`                                                                      | `tests/evaluation/model-evals/codexAgentEval.test.ts`                            | Deterministic model-evaluator logic |
| `tests/composition/analysis-sessions/{boundedCartesianProjection,symbolAnalysis,jsonShape}.test.ts` | `src/domain/{boundedCartesianProjection,symbolAnalysis,jsonShape}.test.ts`       | Colocated pure-domain behavior      |

The same directory mapping applies to the other files moved in each batch:
`tests/acceptance/{analysis,applications,investigations,setup}`,
`tests/boundary/{browser,cli,filesystem,mcp,process,providers}`,
`tests/composition/{analysis-sessions,evidence-investigations,javascript-applications,process-capture,runtime-observation,setup-lifecycle}`,
`tests/conformance`, and `tests/evaluation`. Git rename detection remains the
canonical source for the complete old-to-new path list.

## Per-suite evidence record

Add a row when a legacy suite is materially decomposed, consolidated, replaced,
or removed. “Replacement evidence” must identify executable behavior, a
generated artifact comparison, a protocol probe, or an explicit verifier; a new
path alone is not replacement evidence.

| Legacy suite or claim                           | Disposition  | Replacement evidence                                                                                                                  | Validation                                                                                           | Remaining gap                                                                               |
| ----------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Flat path classification                        | Moved        | Vitest configuration contract proves every deterministic test belongs to exactly one project                                          | Configuration contract test                                                                          | Record any exceptions discovered during cutover                                             |
| Direct session construction outside owner tests | Consolidated | `composeBinarySession` and `composeBinarySessionFromProvider` are the shared production/test seams                                    | Repository search plus session-composition and acceptance tests                                      | None                                                                                        |
| Repeated temporary-directory setup              | Consolidated | `createTestTempDirectory` delegates every test-owned root to the typed workspace fixture with HOME/XDG projection and awaited cleanup | Repository search plus filesystem, process, runtime suites, and the Vitest topology hygiene contract | None; direct `mkdtemp` remains only in the workspace fixture and package-canary source text |
| Repeated CLI/MCP connection helpers             | Consolidated | Typed CLI and MCP fixtures under `tests/support`; CLI output, dispatcher, and server tests use them                                   | Acceptance startup, typed failure, lifecycle, and teardown tests                                     | Provider-specific protocol harnesses remain local                                           |
| Implementation-shaped assertions                | Replaced     | Recording adapters, executable bridge/protocol probes, generated-artifact comparisons, and supported configuration contracts          | Focused boundary/conformance tests and repository search                                             | None identified in the final audit                                                          |
| Module mocks and spies                          | Replaced     | Recording adapters and caller-visible outcomes                                                                                        | Repository search plus focused reload, Ghidra, and enhanced-tool tests                               | None                                                                                        |
| `processCapture.test.ts`                        | Consolidated | Ten lifecycle, observation, reactive, replay, terminal, validation, and trace suites                                                  | 42 focused boundary tests                                                                            | None                                                                                        |
| `cdpBrowserProvider.test.ts`                    | Consolidated | Five discovery, document/script, network, lifecycle, and sensitive-data suites                                                        | 36 focused browser-boundary tests                                                                    | None                                                                                        |
| `javascriptSemanticAnalysis.test.ts`            | Consolidated | Six structure, call, dataflow, runtime, native-binding, and rejection suites                                                          | 29 focused composition tests                                                                         | None                                                                                        |
| `binarySession.test.ts`                         | Consolidated | Nine provider binding, lifecycle, cache, Evidence, permissions, and shutdown suites                                                   | Focused composition tests and shared composition-seam test                                           | None                                                                                        |
| MCP mega-suites                                 | Consolidated | Tool/resource-family suites plus catalog-wide identity and lifecycle coverage                                                         | Focused MCP tests and complete deterministic run                                                     | None                                                                                        |
| Provider client mega-suites                     | Consolidated | Capability-named protocol, timeout, ownership, error, and cleanup suites                                                              | 85 focused provider tests                                                                            | Real systems remain in `verify:*` lanes                                                     |
| Pure domain proofs                              | Moved        | Colocated bounded projection, symbol classification, and JSON-shape tests                                                             | Domain Vitest project                                                                                | Continue moving only tests with no external boundary dependency                             |

Use these dispositions consistently:

- **Moved**: the same material claim now has depth-appropriate ownership.
- **Replaced**: stronger executable evidence supersedes the old assertion.
- **Consolidated**: one retained test proves a claim previously duplicated.
- **Intentionally removed**: the claim was not public or independent; the row
  must still name the retained evidence or explain why none is warranted.
- **In progress**: classification exists but the replacement audit is not
  complete. No final-cutover row may retain this disposition.

The exact old-to-new inventory is mechanically enforced by the project
classification contract and retained in Git rename metadata. Real-system lanes,
coverage, repeated-run stability, and benchmark timing are release evidence;
they are reported separately because they depend on the execution host and
installed external systems.
