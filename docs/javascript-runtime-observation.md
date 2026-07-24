# Passive Node and Electron runtime observation

REA can attach to an already-running Node.js or Electron V8 Inspector target
and retain bounded script-load and execution-context metadata. The
`list_javascript_runtime_targets` and `observe_javascript_runtime` MCP tools
have equivalent `rea list-javascript-runtime-targets` and
`rea observe-javascript-runtime` commands. Successful calls return
deterministic Evidence v2.

This authority is disabled by default and is separate from browser CDP,
Electron file-page inspection, Process Capture, and controlled JavaScript
replay:

```bash
export REA_V8_INSPECTOR_OBSERVE_ENABLED=true
export REA_V8_INSPECTOR_ENDPOINTS_JSON='["http://127.0.0.1:9229"]'
export REA_V8_INSPECTOR_FILE_ROOTS_JSON='["/absolute/path/to/app"]'
export REA_V8_INSPECTOR_ALLOWED_ORIGINS_JSON='[]'

rea list-javascript-runtime-targets http://127.0.0.1:9229 \
  --approved --json
rea observe-javascript-runtime http://127.0.0.1:9229 TARGET_ID \
  --runtime-kind node --approved --json
```

At least one canonical file root or exact HTTP(S) origin is required.
Discovery is restricted to a literal-loopback HTTP endpoint. A target must
match the exact requested target ID, expose a same-port WebSocket reported by
the approved discovery endpoint, and remain inside the requested file or
origin scope. Targets already marked attached are rejected rather than
displacing another debugger. Canonical file paths are checked after symlink resolution.
Excluded locations are counted but never retained.

## Passive protocol boundary

The provider sends exactly two protocol commands:

- `Runtime.enable`
- `Debugger.enable`

It never sends `Runtime.evaluate`, reads script source, installs breakpoints,
pauses or resumes execution, calls `Runtime.runIfWaitingForDebugger`, launches
the target, instruments JavaScript, or invokes Electron APIs. Closing a call
closes only REA's WebSocket.

The direct observations are:

- `Debugger.scriptParsed`, establishing that a bounded script location was
  parsed in the observed execution context;
- `Debugger.scriptFailedToParse`, retained only as a bounded invalid-script
  count;
- `Runtime.executionContextCreated`,
  `Runtime.executionContextDestroyed`, and
  `Runtime.executionContextsCleared`, establishing context lifecycle within
  the capture window.

The Inspector protocol does not directly expose require/import caller edges,
EventEmitter emissions or listener invocation, Electron IPC messages or
handlers, or script-unload events. Those facts remain explicit unknowns.
`scriptParsed` proves script presence, not the importing module, feature
execution, initialization order, or causality.

## Node and Electron roles

The caller declares one role: `node`, `electron-main`, `electron-preload`, or
`electron-renderer`. Node and Electron-main declarations require a protocol
target of type `node`; preload and renderer declarations require `page`.
Inspector does not authenticate the operating-system PID or distinguish an
Electron role, so Evidence records the role authority as
`caller-declared-unverified`.

Electron main, preload, and renderer behavior can therefore be observed only
as separate approved Inspector targets. The provider does not infer that two
targets belong to the same Electron application.

## Bounds and determinism

Every observation commits the window and exact limits for events, scripts,
execution contexts, per-location bytes, and total retained metadata bytes.
Limit hits increment dropped-event counts and set `capture.truncated`; they
never become completeness claims. Scripts are authorized after capture,
deduplicated by stable metadata, and canonically sorted. Wall-clock timestamps
and protocol script IDs are excluded from the durable result, so identical
inputs and captured metadata produce the same Evidence ID.

Inspector attach is inherently incomplete. Enabling `Debugger` reports known
and uncollected scripts, but scripts collected before attachment may be
missing. Absence from a bounded capture never proves that a script or behavior
does not occur.

## Static correlation

Pass the resulting observation Evidence and an
`analyze_javascript_application` Evidence record to
`reconcile_javascript_runtime`. The reconciliation accepts this provider
alongside passive web and Electron page captures. Exact approved file or URL
mappings can correlate script presence with JavaScript Application Graph
assets. Because this provider never reads source bytes, matches normally use a
unique authorized location and remain weaker than captured-byte identity.
Builtin `node:` scripts remain runtime-only nodes unless a future explicit
static authority models them.
