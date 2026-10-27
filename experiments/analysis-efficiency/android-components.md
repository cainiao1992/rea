# Android component declarations and selected retained facts

Addresses [#4448](https://github.com/morluto/rea/issues/4448), extending the inventory
already on main. Builds on Harsh's partial [#7264](https://github.com/morluto/rea/pull/7264)
revision `987b5aceb66c7526e47cf6d064c22029c2f48c04`, including its process budget.
The historical-field correction preserves omission and marks unknown coverage;
new fields are never invented as absent in old Evidence.

## Owner and compatibility

The Android manifest parser owns declaration interpretation. A shared domain
contract replaces duplicated provider/domain declarations; a single namespace
reader and one nested-declaration pass produce structured filters and existing
flattened action/category fields. Source positions address the exact retained
decoded text. Unsupported data constraints and filter constructs mark partial
coverage, including scheme-specific-part attributes outside the projected fields.
The producer emits all current fields; historical readers accept omitted fields.

Existing complete requests and the existing default summary remain available.
An explicit components view selects exact names/kinds/actions/exported declarations,
fields and pages. Component summaries count explicit/default exports separately.
CLI and MCP share the retained projection and retain complete parent Evidence.
Repeated views reuse validated sealed records under the existing session lifetime;
no new persistent provider cache or live-state freshness claim is introduced.
Rows always retain the parent array ordinal and declaration coverage. The APK
subject, engine identity, source status, limitations and parent linkage remain
available. Nothing here establishes runtime enabling, resource resolution, Android
URI matching, signature authenticity or execution of an app.

## Reproduction inputs

The old runtime is main `15a8f6847ccac581c7ff717b42062a54b1ba8084`.
The timing/token qualification below was captured on that pinned base before the
feature was rebased onto main `6207843814e5267e3a1d9796d5800346f69dc7da`.
The Android producer, bridge and view sources had no upstream changes in that
range; latest-main integration is checked separately rather than relabeling the
older runtime receipts.
Actual verification uses Linux x86-64, Node 24.22.1, Temurin 21.0.12.1,
JADX headless MCP 0.7.1 and the existing REA Java bridge protocol 7.
JAR SHA-256: `6e5eacf500b64292bfb73c49797c1958f6ee44646e43e868039ae7feb573ff75`.
The public [Appium ApiDemos 6.0.18 APK](https://github.com/appium/android-apidemos/releases/download/v6.0.18/ApiDemos-debug.apk)
is 6,521,217 bytes, SHA-256
`a9eecf37b26cd084855c530db81c2bb1b91f4c1b095a04f47aa7c20e2791f686`.
It has 355 declared components and 152,541 decoded manifest UTF-16 units.
The recorded sorted relative-path/SHA-256 tables cover compiled `dist/*.js` and
JSON recursively, the dispatcher/environment helper and Android bridge. Table
SHA-256: old runtime `9581afe8ba48c15d803dd7ed3ffc4d10e4e4b99857a0b90206c8012e266daffe`
(2,435 files), final candidate
`a78698c12ae1dc514ffd3f09ca1b881747c9dde7d1a8677ceed7de3233334c40`
(2,439 files). Raw tables remain with the private receipts.

`android-components.mjs` exercises actual public stdio MCP tools and validates
results against the selected named SDK tool definition. Supply `--repository`,
`--target`, a fresh `--output` directory, `--mode before|after`, `--java-home` and
`--jar`. It captures the selected catalog, every RPC, complete exported parents,
first-capture and warm-session results, and checks APK identity and an independent
stdlib ElementTree oracle. No production manifest parser is reused by that oracle.
Keep raw results, APKs and resource receipts outside Git. The selected tool families
are android/application/session, with compact input schemas, two allowed CPUs,
one analysis worker, 1 GiB JVM heap and a 3 GiB Node heap. A separate supervisor
samples process-family memory every 100 ms, with an 8 GiB early stop and a 4 GiB
host-available-memory floor. No guard stop or OOM occurred in these measurements.

## Equivalent completed question

Find the receiver declaring `android.provider.Telephony.SMS_RECEIVED` and report
its identity, permission, enabled/process declarations, per-filter priority and
source position. The old runtime needs complete manifest delivery for the new
facets. The selected candidate returns the matching row directly. Both treatments
make one inspection plus one complete Evidence export per capture; the oracle
verifies one positive match and the total count of 355 source declarations. An additional capture
uses the same server/engine session. First capture is a fresh process/session,
not a flushed OS page cache. Export costs and the extra call are included.

Initial candidate qualification passed the independent oracle. It measured
first/warm inspection RPCs of 11.395/0.329 seconds versus the old runtime's
10.534/0.314 seconds. The complete two-capture process family took 19.065 seconds,
27.687 CPU seconds and 1,193,615,360 peak sampled RSS bytes versus
16.534 seconds, 24.675 CPU seconds and 1,107,955,712 bytes. This run predates the
additional unsupported-data-attribute coverage correction. It establishes no
latency, CPU or memory improvement; retained data has more declaration facts.

The final coverage-corrected candidate and a repeated immutable-main control
also passed the identical oracle. Preserve all four receipts rather than choosing
a favorable timing:

| Runtime, execution order | First/warm inspection RPC seconds | Whole two-capture seconds | CPU seconds | Peak sampled family RSS bytes |
| ------------------------ | --------------------------------: | ------------------------: | ----------: | ----------------------------: |
| Main control 1           |                    10.534 / 0.314 |                    16.534 |      24.675 |                 1,107,955,712 |
| Initial candidate        |                    11.395 / 0.329 |                    19.065 |      27.687 |                 1,193,615,360 |
| Final candidate          |                    14.558 / 0.571 |                    23.369 |      36.031 |                 1,145,073,664 |
| Main control 2           |                    26.348 / 0.511 |                    36.537 |      36.381 |                 1,168,494,592 |

The repeated main control shows substantial host/run variation. These samples
establish neither a deterministic slowdown nor a speedup; warm candidate RPCs
are slightly slower in both observations. RSS is the sum of family RSS sampled
every 100 ms, so shared pages may count more than once and short peaks may be
missed; it is not a kernel/cgroup peak. Tokenizer processing is outside the timed
SDK runs. Local oracle work, hashing, discovery, serialization, proof export and
cleanup are inside. Cold/warm CPU and memory are not separately measured.

For the first main control and final candidate, `o200k_base` estimates give:

| Cost per first capture                                       | Old complete | Selected components |
| ------------------------------------------------------------ | -----------: | ------------------: |
| Inspection reply bytes                                       |      978,381 |              11,307 |
| Inspection reply estimated tokens                            |      225,926 |               2,715 |
| Selected family name/description/input-schema catalog tokens |       14,855 |              15,346 |
| Question + input catalog + both call arguments/text replies  |      118,430 |              16,893 |
| Full SDK catalog, including output schemas, + both calls     |      516,533 |             299,566 |

The primary text projection counts a fixed question, the input catalog once, all
call arguments and every text reply, including export receipts. The SDK transport
row additionally counts output schemas and structuredContent; it is not equated
with model context. Reproduce with `android-component-costs.py --output costs.json
BEFORE_DIRECTORY AFTER_DIRECTORY` (requires tiktoken). The manifest file exported locally is retained
proof, not inline model context. These are tokenizer estimates of scripted SDK
workflows, not billed model usage or a measured autonomous-agent task. They do
not establish fewer model rounds or a generic analysis speedup. Actual provider
work still reads the complete manifest, and schema discovery grows.

## Global catalog compatibility

The actual CI merge `10746a4e8f8c622357cf8dd529f98adc8bf06d2b` combines the feature
with main parent `86d4a21215cb0fbafaf555b5c7d9fcda3f255d82`. Real SDK discovery,
using the same complete contract registrations as the existing profile test, gives:

| Explicit wire profiles         | Pure main bytes | CI merge bytes |
| ------------------------------ | --------------: | -------------: |
| Full input / full output       |       4,398,561 |      4,425,163 |
| Compact input / compact output |         556,450 |        558,653 |
| Compact input / output off     |         302,913 |        305,116 |
| Full input / output off        |       1,047,039 |      1,052,239 |

Input presentation defaults to compact; output presentation defaults to full.
For frame-capped hosts, compact/off outputs are explicit compatibility choices.
The bounded compatibility combinations retain the existing one-megabyte test
limit and per-schema budgets. New selectors add 5,200 bytes with full inputs:
2,699 input bytes and 379 description bytes on `inspect_android_package`, plus
2,122 input bytes on the retained-view operation. Compact-input discovery grows
2,203 bytes. These global discovery costs are distinct from the selected-family
task token estimates above.

This change crosses the old test assertion for full input with output off.
That assertion was broader than its default-compact test name and the existing
profile documentation: full inputs deliberately preserve complete guidance and
can dominate the frame even without output schemas. The corrected test retains
both compact-input frame limits, compares every full input schema with its named
canonical advertisement under full/off outputs, preserves the entire tool set,
and verifies that off removes only output advertisements. No production limit is
raised and no full input validation/guidance is discarded. The owning guide now
states this full-profile boundary explicitly.

## Verification boundaries and failed attempts

The real Java regression exercises the existing raw/default-package class selector,
native absence, references and frozen metadata around neighbouring source generation.
An initial assertion compared the entire usage object: JADX legitimately populated
`def_pos` from 0 to 103 after generating source. The revised assertion excludes only
that presentation position and keeps class/method identity, raw DEX invoke IDs,
descriptor/overload facts and invoke offsets. Production bridge behavior and version
are unchanged.

One combined focused run passed 121 checks but hit the existing 30-second MCP test
timeout while advertising every unrelated tool family to the SDK. Its failed receipt
is retained. The Android-specific test now selects the same relevant families as
the real SDK workflow; its named schemas, retained manifest/source-removal behavior,
full/summary compatibility and complete Evidence export assertions remain enabled.
A subsequent run exposed a test assertion that incorrectly expected repeated
acquisitions to reuse the first Evidence ID. Each selected capture now proves its
own retained parent exists and has the same artifact and normalized facts; engine
reuse does not collapse distinct acquisition identities.

ApiDemos contains no URI data declarations. The checked-in manifest/resources and
Smali container permit a second source-built APK with real AAPT2 binary XML and
JADX decoding, including two filters, URI data, metadata, a resource boolean,
explicit process and provider URI grants. Compiled APK/DEX outputs are private.
Static declaration verification does not execute these component classes.
The source-built APK SHA-256 was
`aea6ac64630ad70e93f4d85de0237cc51a7012b077ca0d0e7b24cf22c5737532`.
Its real CLI selected view and retained bundle passed `verify-fixture.py`, including
AAPT2 dump comparison, all source positions, grouping, raw resource references,
metadata names and provider URI grants. The real SDK VIEW query passed the
independent ElementTree oracle on first and warm capture. An initial fixture build
used Smali's CLI and failed because the engine JAR does not bundle optional
JCommander; `BuildDex.java` now calls the already bundled Smali API directly.

The real metadata helper passed all Java markers and downstream CLI/MCP method
body and direct-invoke parity checks for both classes.dex and classes2.dex:
149.436 seconds, 204.026 CPU seconds and 1,070,514,176 sampled peak family RSS bytes.
No production bridge change was needed for default-package selectors.

A genuine complete parent from the old runtime also passed a new CLI retained
component query with an explicitly nonexistent engine JAR. Its newly introduced
fields remained omitted and row coverage remained unknown; no APK/provider
reopening was required. The current source checks cover 111 parser cases,
six projection cases, four CLI early-validation cases and four MCP cases,
including named SDK-converted schemas and retained source-removal behavior.

After the rebase onto `6207843814e5267e3a1d9796d5800346f69dc7da`, type/lint,
all 125 focused cases and the nine documentation conformance cases passed again.
A fresh real ApiDemos SDK qualification also passed the independent oracle:
first/warm RPCs 11.291/0.290 seconds, whole two-capture elapsed 17.008 seconds,
CPU 26.425 seconds and peak sampled family RSS 1,166,245,888 bytes. This is latest-main
integration evidence; it is not paired with a new baseline performance cohort.

Review follow-up: Greptile correctly identified that the original oracle filtered
before comparison, so the timing cohorts above verified selected-receiver facts
and the inventory count, not every unselected component's facts. The oracle now
returns an unfiltered inventory and derives the selected list from it. The driver
checks every retained parent's identity, enabled/raw-enabled/process/permission,
filter grouping/data/priority, metadata names, declaration coverage and component
source location before checking the selected page. The receipt records both the
verified count and scope; historical mode checks the available identity/permission
facets without inventing the new observations. A fresh real ApiDemos first/warm
run passed all 355 rows in both captures (16.538 seconds, 24.977 CPU seconds,
1,176,817,664 sampled peak family RSS bytes). The older receipts remain unchanged. The unfiltered historical-mode run also
passed all 355 available identity/permission rows in both captures; the compiled
manifest fixture passed all three current rows plus its selected VIEW page.

Platform coverage is Linux/JDK21/JADX0.7.1 only. Android devices, emulators, actual
runtime enabling/registration, other JDKs and Windows/macOS are unverified here.
