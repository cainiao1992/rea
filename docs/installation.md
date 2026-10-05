# Installation and setup

REA separates installing its CLI from configuring external software and agents.

## Start setup

The recommended setup entrypoint is:

```bash
npx --yes rea-agents@latest setup
```

If npm asks to download and run the package, that approval applies only to the
current package-runner invocation. REA still prints its own setup plan and asks
for separate approval before changing agent configuration or installing a
product-owned component.

The explicit `@latest` request prevents a project dependency or stale npx cache
entry from choosing the setup version.
REA runs the version npm selected and never silently replaces an intentional
version request after launch. To repair registrations written by an older
release, rerun the command above and review the resulting setup plan.

For an intentional rollback, make the package request explicit:

```bash
npm exec --yes --package=rea-agents@2.4.0 -- rea setup
```

Setup continues to pin persistent MCP registrations to the exact version that
performed setup. Running current setup later migrates unversioned or older
managed registrations through the normal reviewed setup transaction.

REA supports Node.js 22.19+ and 24.11+ (including newer releases). It uses the npm already paired with that runtime and never upgrades Node.js, npm, or Homebrew.

Running `npm install rea-agents` without `--global` installs the executable only
in the current project's `node_modules/.bin`; it does not make `rea` available
on the shell `PATH`. Use the explicit setup command above for the guided setup
journey, `npx -y rea-agents@latest` for unattended one-off commands, or install globally
with `npm install --global rea-agents` for a shell-visible `rea` command.

The optional curl wrapper installs only the global npm package:

```bash
curl -fsSL https://raw.githubusercontent.com/morluto/rea/main/install.sh | bash
```

It prints the version, runtime, npm command, and destination before installing. When a controlling terminal exists it starts `rea setup`; otherwise it prints the command to run later.

Pass options with `bash -s --`:

```bash
curl -fsSL https://raw.githubusercontent.com/morluto/rea/main/install.sh |
  bash -s -- --dry-run
```

Supported options are `--version <semver>`, `--dry-run`, `--no-setup`, `--no-prompt`, and `--verbose`. Neither `--no-prompt` nor a non-interactive shell grants permission to install external dependencies.

## Review setup changes

`rea setup` uses an inline, scroll-preserving journey inspired by the clarity of
PostHog's CLI wizard. It begins with the outcome instead of the installer
mechanics:

- investigate local applications from a supported agent;
- recover evidence through an available deep-analysis provider;
- use the bundled skill for a repeatable investigation workflow.

REA then summarizes the detected clients and asks which capabilities to set up.
The capability picker pre-selects `Agent integration` (the MCP registration and
matching guided workflow together) when detected agents exist, and presents the
optional Hopper provider alongside it. Selecting agent integration opens a second
checklist for the exact detected agents that should receive a registration; all
detected agents are pre-selected. Detection provides context and pre-selection;
it does not authorize a configuration write until the user confirms.

Because the user has explicitly invoked `rea setup`, the wizard biases toward the
happy path: capabilities and agents are pre-selected, and the final approval
defaults to **Yes**. The user can still deselect any item or cancel at any prompt.
Choosing no capabilities exits without changes. Selecting agent integration
always includes the bundled skill, even if all agents are deselected. The picker
keeps its navigation, selection, confirmation, and cancellation keys visible
instead of relying on a transient hint.

Every selected path converges on the same exact preflight. REA validates the
current state, prints the proposed effects, and asks for final approval with
**Yes** as the default. Selection alone never authorizes a mutation. The plan
identifies:

- an existing Hopper installation, a verified existing Ghidra installation, or the official Hopper package it proposes to install;
- each detected agent configuration path;
- the REA skill destination;
- external software, network origins, integrity evidence, and package-manager
  commands.

Malformed or unsafe existing configuration blocks the whole transaction before
Hopper installation or any file write. Declining, pressing Ctrl-C, or selecting
nothing makes no changes. Agent configuration writes preserve unrelated
entries, create backups, use atomic replacement, and verify their result.

Progress remains append-only so completed and failed operations stay visible in
terminal history. After a successful run, the completion message names the
verified capabilities now available, such as configured MCP clients, the
selected analysis provider, and the installed skill, and gives the corresponding
next action. When an agent must restart to load its registration, REA says so;
otherwise it suggests beginning an investigation. It does not advertise a
capability that the final diagnostic check did not verify.

Select exact clients in scripts with repeatable `--client` flags, or retain
automatic discovery explicitly with `--all-detected`. Use `--skill=false` to
override the normal bundled-skill installation and `--dry-run` for a read-only
plan:

```bash
rea setup --client codex --client cursor --skill=false --dry-run
```

Prompt UI and progress are written to stderr so stdout remains available for
structured results and pipelines. `NO_COLOR=1` disables color. Use
`--accessible` for sequential, vertically rendered yes/no prompts.

For automation, `rea setup --json` reports the plan without applying it.
Prefer pairing `--yes` with explicit scope such as `--client codex`,
or `--all-detected`. Legacy unscoped `--yes` remains compatible for
this release but emits a deprecation warning. Installing missing Hopper
non-interactively additionally requires `--install-hopper`:

```bash
rea setup --yes --all-detected --install-hopper --json
```

Setup pins package-runner MCP registrations to the exact installed REA version,
installs the matching skill and on-demand references in the same plan, and adds
`startup_timeout_sec = 30` for Codex. Interactive `rea upgrade` installs the new
executable and then opens the updated `rea setup --all-detected` plan for
separate approval. Structured or non-TTY upgrades defer that integration sync.
Use the same setup command to migrate floating, unversioned, or stale
registrations, then restart changed clients.

## Hopper

Hopper is separate commercial software with its own license. Its free demo has
vendor-defined limits, and a paid license is optional. REA reuses any detected
installation and preserves Hopper during uninstall.

On macOS, approved setup downloads the official DMG, checks its published size
and digest, validates the application bundle, and atomically installs it to
`~/Applications/Hopper Disassembler.app`. REA then opens Hopper so the
operator can choose its demo mode or activate an existing license. Homebrew and
administrator access are not used.

The Hopper launcher action used by REA creates a document from an executable;
its supported command-line interface does not attach to an already-open
document. While another live REA session owns the same target and loader
profile, a second session reports the owning run ID instead of opening a
duplicate document. Closing the owning REA session releases this guard; Hopper
keeps its document open. A later REA session can therefore open another
document for the same target. REA does not currently identify, focus, or reuse
that existing GUI document, and the supported launcher exposes no attach or
reuse action for it.

On supported Linux distributions, approved setup verifies Hopper's official
`.deb`, `.rpm`, or Arch package before invoking the native package manager.
REA runs the supported demo build on a private Xvfb display and selects Hopper's
offered demo mode for each analysis session; it does not require the user's
desktop display. Unattended package-manager access requires
`--yes --install-hopper`. If the host exposes `/tmp/.X11-unix` as an immutable
mount, REA first verifies the conflict and then uses an unprivileged user and
mount namespace with a private mode-1777 tmpfs over that directory only. The
host mount and the rest of `/tmp` remain unchanged; this fallback never invokes
`sudo`. `rea doctor --provider hopper --json` reports the selected
strategy and both host and effective mount facts.

### Hopper in CI

REA's unattended Linux path is validated against Hopper's offered demo mode.
A paid license is not required for that path, and REA does not read, install, or
automate license credentials. Licensed Hopper installations remain supported,
but license activation is an operator-owned prerequisite rather than part of
REA setup.

macOS requires Hopper's first-run UI to be completed in the same user session
that will run REA: choose the demo mode or activate an existing license before
starting an unattended job. Ephemeral macOS runners therefore need a
pre-provisioned user session or a deliberate interactive bootstrap step.

When Hopper cannot start in CI, run
`rea doctor --provider hopper --json` in the failing runner.
Structured failures distinguish private-display dependencies, an unsupported
demo dialog or build, process-ownership conflicts, and an early lifecycle exit.
Apply the reported remediation rather than exposing the runner's desktop,
copying license secrets into logs, or killing unrelated Hopper processes.

## Ghidra

REA connects to an existing Ghidra installation on Linux x64 or macOS x64/arm64.
It requires Ghidra 12.1.4 and a 64-bit full JDK 21. On macOS, the installation
must include the native decompiler for the host architecture; REA does not
build it or change Gatekeeper quarantine settings.

The adapter exposes 22 read-only operations: ten inventory/name/search
operations and twelve function-analysis operations. These cover metadata,
decompilation, assembly, resolved calls, typed references, xrefs, function
dossiers, instructions, and recovered data types. GUI controls and annotation
changes require Hopper.

Windows Ghidra operations are currently unavailable. The adapter reports
`unsupported_host` until verified Job Object process ownership, private runtime
DACLs, and reparse-safe path admission are implemented. The
[Windows Ghidra P0 guide](windows-ghidra-p0.md) describes the intended boundary
and remaining controls.

Extract Ghidra and install the JDK outside REA, then export absolute paths:

```bash
export GHIDRA_INSTALL_DIR=/absolute/path/to/ghidra_12.1.4_PUBLIC
export JAVA_HOME=/absolute/path/to/jdk-21 # optional if java/javac are on PATH
rea doctor --json
rea setup
```

For Windows diagnostics, use the same installation paths in PowerShell. These settings do not enable the blocked analysis operations:

```powershell
$env:GHIDRA_INSTALL_DIR = "C:\tools\ghidra_12.1.4_PUBLIC"
$env:JAVA_HOME = "C:\Program Files\Java\jdk-21"
rea doctor --json
rea providers --json
```

`rea setup` does not mutate Windows client configuration or install Hopper,
Ghidra, Java, Python, or another package. Manual MCP registration does not
enable the blocked Ghidra operations. See [Windows Ghidra P0](windows-ghidra-p0.md)
for diagnostics and the proposed registration format.

Doctor validates the platform, architecture, application version,
`support/analyzeHeadless` or `support/analyzeHeadless.bat`, Java
version/bitness, and the presence of `javac`/`javac.exe`.
When Java is found through `PATH`, setup records its observed JDK home so GUI
MCP clients do not depend on an incidental shell path. Setup shows every exact
environment entry in its plan, writes only after approval, and never downloads,
installs, upgrades, or modifies Ghidra or Java.

Each verified session uses an ephemeral temporary project and isolated
home/cache/config/temp paths. REA passes `-readOnly`, `-deleteProject`, uses
Ghidra's default analysis and resource settings, and loads its packaged Java
bridge via `-scriptPath`; it never opens an existing user project. Linux and
macOS use a current-user-only local bridge socket and descriptor. The
experimental Windows transport uses authenticated IPv4 loopback, but missing
native ownership and path controls keep Windows operations unavailable.

Operations begin only after default auto-analysis completes. The provider
startup deadline fails the open rather than exposing partial analysis. One
session contains exactly one imported Program; use `provider_id: "ghidra"`, `--provider ghidra`, or
`REA_ANALYSIS_PROVIDER=ghidra` when both Hopper and Ghidra support the target.
One persistent decompiler is owned by the Program, and a serial queue keeps
Ghidra API calls on the owning Program thread without a fixed queue length.
Operations run until a result, caller cancellation, or provider shutdown; there
is no fixed per-operation or response-size ceiling. Unresolved computed calls
remain unknown, reference-kind provenance is preserved, and provider-specific
pseudocode is never treated as original source or Hopper-equivalent text.

Run `GHIDRA_INSTALL_DIR=... npm run verify:ghidra` from a source checkout to
compile and analyze debug and stripped host-native fixtures (ELF on Linux x64
or Mach-O on macOS), plus a native DWARF 4 type-layout object. This lane needs a
host C compiler in addition to Ghidra and its JDK.

Run `GHIDRA_INSTALL_DIR=... npm run verify:ghidra:cross-format` to add AArch64
ELF, x86-64 PE, and x86-64 Mach-O fixture coverage. This separate lane needs
`clang`, LLD, and `lld-link` on `PATH`; `REA_CLANG` and `REA_LLD_LINK` select
alternate command paths. Missing cross-target tooling does not block the
host-native Ghidra acceptance lane.

On a controlled Windows x64 runner, use
`npm run verify:ghidra:windows`. The verifier generates a deterministic native
PE fixture from source bytes and requires the Windows native authority before
opening the provider. This lane remains blocked until those controls are
implemented; its intended checks include operation coverage, digest identity,
and complete runtime cleanup.

## Diagnose, update, and remove

`rea doctor --json` is strictly read-only. `rea upgrade` updates only the npm installation that owns the running CLI. `rea uninstall` removes only REA-owned agent registrations and skill files; `--purge-data` additionally removes REA cache and state paths.

## MCP Registry

REA is published in the official MCP Registry as `io.github.morluto/rea`. Registry
clients can discover the server and install the existing public `rea-agents` npm
package; the Registry entry does not introduce a second distribution artifact.

For a client that supports Registry discovery, search for `io.github.morluto/rea`
and select the npm package. The published metadata launches the existing stdio
server through `npx` with the `mcp` command.

For a client that requires manual configuration, use:

```json
{
  "mcpServers": {
    "rea": {
      "command": "npx",
      "args": ["-y", "rea-agents@latest", "mcp"]
    }
  }
}
```

Use an exact `rea-agents@VERSION` in the arguments when a reproducible client
configuration is required. `rea setup` writes the same package-runner shape and
pins it to the exact version that performed setup.
