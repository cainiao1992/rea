# Admission limits and recovery

How to add a REA-owned admission ceiling, budget, or deadline, and what a caller
does when one is hit. This is a design rule, not an inventory. Ceilings that
should become settings are tracked in
[#6176](https://github.com/morluto/rea/issues/6176). Naming honesty for limit
errors is [#5910](https://github.com/morluto/rea/issues/5910).

## Name a default, then a setting when operators need headroom

Put the number in a named constant with a unit. Do not leave it as a magic
number at the call site.

When a workload may need more room, add a setting whose unset value is that
constant. Pure numeric contracts live in `src/domain/analysisResourceLimits.ts`
or their existing domain owner. `analysisSettingDefinitions.ts` binds the
curated runtime IDs to those same bounds, defaults and application points.
Environment parsers and recovery text stay under `src/config/`; register launch
schemas on `environmentSchema` so startup and doctor agree. Add launch settings
to `SELECTED_REGISTRATION_SETTINGS` when setup should forward them. Unset keeps
today's behavior. An invalid launch value is `configuration_invalid`, never a
silent fallback. An invalid runtime write is `invalid_request` and changes
nothing.

For example, `regex.matching_deadline_ms` and its launch seed
`REA_REGEX_MATCHING_DEADLINE_MS` share a 5000 ms default, 1 ms floor and
2147483647 ms maximum. Node schedules a longer `setTimeout` delay as 1 ms.
Changing the runtime setting affects the next accepted search; changing the
launch environment affects the next REA process.

[`REA_MCP_MAX_RESPONSE_BYTES`](https://github.com/morluto/rea/blob/main/src/config/mcpResponseBudget.ts)
is the byte-budget shape: a decimal safe integer with a 10 MiB floor
(`MINIMUM_RESPONSE_BYTES`), the same shared schema, and no silent fallback. A
change needs a REA restart and a matching client receive buffer. It does not
raise REA's reserved string limit or Node's string ceiling. The setup
allowlist does not copy this setting. A new headroom setting should, following
the regex deadline.

A per-call budget is not an environment setting. JavaScript `max_heap_mb`
(CLI `--max-heap-mb`) is an integer from 128 to 16384 MiB, default 1024. It
applies on the next analysis, which starts a new worker, and does not restart
REA. It does not raise the parent result budget, transfer ceilings, or fixed
parser limits.

Host memory and `NODE_OPTIONS` do not raise a REA admission unless that
admission's recovery says so. The JavaScript parent result budget is one that
does: its recovery says to set `NODE_OPTIONS` (for example
`--max-old-space-size=<MiB>`) on the process that starts REA, then restart
that process. `max_heap_mb` does not raise it.

## Runtime settings through MCP

`inspect_analysis_settings` lists the curated settings, their current and launch
values, source, bounds, application point and relevant operation names. Filters
by exact setting IDs, provider or operation intersect. Active worker values are explicitly `not_observed`; a configured default is
not a measurement of active work. Inspection also separates known server limits from unknown client deadlines and receive buffers.

`update_analysis_settings` accepts an atomic `changes` array. Each entry names
an exact `setting` and either `action: "set"` with a schema-validated `value`, or
`action: "reset"`. Reset restores the launch value. `expected_revision` is an
optional compare-and-set guard; conflicts and duplicate keys change nothing.
An unchanged write does not advance the revision.

| Runtime setting                                               | Application point                                                      |
| ------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `asar.max_header_bytes`                                       | Next archive operation, including full JavaScript application analysis |
| `ghidra.startup_timeout_ms`, `hopper.startup_timeout_ms`      | Next provider startup attempt                                          |
| `ghidra.decompile_timeout_seconds`                            | Next operation on the existing Ghidra Program; `null` means unbounded  |
| `jadx.operation_timeout_ms`                                   | Next JADX operation                                                    |
| `regex.matching_deadline_ms`, `regex.worker_heap_request_mib` | Next search / new regex worker                                         |
| `capture.decoder_old_generation_mib`                          | Next owned capture decoder                                             |
| `javascript.analysis_timeout_ms`, `javascript.max_heap_mb`    | Next source analysis / new JavaScript worker                           |
| `wasm.command_timeout_ms`                                     | Next WABT operation                                                    |

Explicit per-call arguments take precedence over runtime defaults, then launch
configuration and built-in defaults. Each accepted MCP operation retains one
immutable snapshot, including queued work. A write does not extend active work,
relaunch a provider, clear retained cleanup, or invalidate successful Evidence.
Transient Ghidra decompile failures remain uncached so a raised deadline can
recover on the same Program. Cached ASAR headers are checked against the new
operation's admission, including after a decrease.

Overrides belong to one REA runtime, survive target close/open, and disappear
when REA exits. Connections sharing that runtime share its overrides. No files,
ambient environment, registrations or upstream software are edited. Embedders
composing their own providers must inject the same `AnalysisSettings.read` into
provider composition and pass that store to `createServer`; custom provider
implementations own their integration with these controls.

An ASAR admission error supplies `details.limit` with the exact setting,
effective value, units, bounds, scope, application point, restart requirement
and, when known, required bytes and value source. The agent can immediately call:

```json
{
  "changes": [
    { "setting": "asar.max_header_bytes", "action": "set", "value": 33554432 }
  ]
}
```

Then retry the same full-archive request once work and cleanup have settled.
No preliminary inspection or source subset is required. The setter does not
retry automatically. If an explicit per-call value caused the failure, correct
that argument; raising a runtime default cannot override it.

## Keep a fixed ceiling honest

If the ceiling must stay fixed, say so in the failure. Name the limit and the
effective value, say this release has no runtime override, and name what does
not raise it. Do not invent a setting.

JSON values stop at `MAX_JSON_DEPTH` (1000) in
[`jsonValue.ts`](https://github.com/morluto/rea/blob/main/src/domain/jsonValue.ts):
"JSON value exceeds maximum nesting depth of 1000. This release has no runtime
override."

## Recovery text

The string the caller sees includes:

- the limit or setting name
- the effective value and unit
- the source when known (`default`, `setting`, `runtime`, or `request`)
- the default, the maximum, and the floor when the setting has one
- the next action, including where to set it ("in the environment that starts REA")
- whether a restart is required
- what the change does not raise

Invalid launch settings never take this path. They are `configuration_invalid`.
Doctor reports `runtime-configuration:<setting>` and says to correct it in the
shell or the MCP registration, then rerun.

## What agents do

Use `details.limit` for a direct runtime update when it names an editable
setting. Follow `remediation.action` for per-call, fixed and external controls.
Inspect settings only when bounds or application details are missing. Restart only when it says the value is
read at startup. A sentence that a control does not raise the limit is not a
request to change it.

- Dropped MCP connection: retry the call once only when it is safe to repeat
  or known not to have started. If it may already have changed the target, or
  it fails again, tell the user and ask them to restart the MCP client. Do not
  start with `rea doctor`
  ([#6353](https://github.com/morluto/rea/pull/6353)).
- REA could not start its connection: retry once. If it fails again, tell the
  user and ask them to restart the MCP client, then run `rea doctor`. Do not
  retry a startup that returns the same unchanged result: tell the user REA
  could not start, ask them to restart the MCP client, then run `rea doctor`.
- Unexpected process-command failure: do not repeat the command. Tell the user
  to check the input files, then run `rea doctor`.
- `cleanup_incomplete`: the operation is not retryable. Retry that exact
  cleanup owner, named in `details.resources`, and wait until it confirms
  release before admitting new work on those resources
  ([#6357](https://github.com/morluto/rea/pull/6357)).
- `resource_constraint` for capacity, when `retryable` is true: wait for the
  active admission to finish, then retry within the reported limits. Do not
  restart REA to free the slot.
- `configuration_invalid`: correct the named setting in the environment that
  starts REA, then start REA again. Run `rea doctor` for the
  `runtime-configuration:` check. Re-run `rea setup` for that client when the
  setting is on the registration allowlist, then reconnect so the new process
  sees it.
- `invalid_request`: correct the reported fields from the current schema or
  CLI help. Do not repeat the unchanged call.

A restart is required to adopt a changed launch environment or registration.
The curated runtime settings above require no REA restart. It is not the first step for a transient
MCP drop, a capacity wait, or retained cleanup.

## Tests

Lock the unset default, one accepted override, rejected floor, maximum, and
syntax, and the recovery sentence through `parseEnvironment` and `parseConfig`.
[`regexMatchingDeadline.test.ts`](https://github.com/morluto/rea/blob/main/src/config/regexMatchingDeadline.test.ts)
is the pattern. Project the failure and assert `configuration_invalid` for a
bad value and the recovery wording for a hit.

Runtime checks cover atomic validation, stale writes, reset, runtime isolation,
accepted-operation snapshots, and explicit argument precedence. Public MCP
acceptance must reject an oversized ASAR, raise admission, and successfully
retry the same complete archive on the same connection. Lowering admission must
also refuse previously cached headers. The real Ghidra timeout verifier checks
recovery after a live update without replacing its session.
