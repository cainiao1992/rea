# Reconstruction coverage

`rea evaluate-reconstruction-coverage coverage.json --json` evaluates an inline
coverage workspace and its selected `boundary_id`. MCP exposes the same input
through `evaluate_reconstruction_coverage`. Results contain a status, reasons,
recommended probes and Evidence references; the supplied bundle retains the
complete records.

Evidence IDs and bundle manifests must authenticate before evaluation. A valid
record can still be insufficient proof: a passing verifier summary cannot
promote inferred Evidence into a replay observation. That case returns
`unknown`, while a missing or tampered record remains an input error.

## Comparable verifier Evidence

At least one record explicitly cited by the latest verifier observation must
support the declared contract authority:

| Contract authority  | Evidence source                           | Confidence              |
| ------------------- | ----------------------------------------- | ----------------------- |
| `shipped-artifact`  | `shipped-artifact`                        | `observed` or `derived` |
| `controlled-replay` | `controlled-replay`                       | `observed`              |
| `live-observation`  | `controlled-replay` or `external-service` | `observed`              |
| `external`          | `external-service`                        | `observed`              |

Contextual references can accompany qualifying proof. An unrelated observed
record elsewhere in the bundle cannot repair a result that cites only
inference. Older observed results cannot replace the newest weak result.
Equivalent observations at the same instant can share qualifying proof from
one of those observations; conflicting tied assessments remain unknown.

## Package and integration proof

Build, clean-install and runtime-routing claims require observed runtime
Evidence (`controlled-replay` or `external-service`). Package-content and
authority-independence audits can also use observed or derived
`shipped-artifact` Evidence. Each proof must cite its qualifying records and
cover the selected boundary's artifact digests. An inference alone establishes
neither a passing nor a failed package workflow.

The evaluator preserves Evidence provenance and returns an actionable unknown
when qualification is unavailable. It does not change the cited records to
make their authority match a caller's declaration.

## Function reconstruction claims

`verify_reconstruction` evaluates declared claims over retained comparison
Evidence. An `overall` function claim includes active residual unknowns scoped
to any of that comparison's dimensions. For example, an open pseudocode
question keeps the overall claim `unknown` and retains its unknown ID and
recommended probe; an independent assembly claim can still pass. An unknown
scoped only to `overall` does not block every individual dimension.

Selection uses each unknown's latest revision, its comparison identity and
Evidence references. Explicit unknown dependencies remain relevant across
dimensions. Unknowns for another comparison and resolved heads do not become
blockers merely because their source Evidence overlaps.
