import { commandObservationSchema } from "../domain/commandObservation.js";
import { objdumpSummaryViewResultSchema } from "../domain/analysisView/analysisView.js";

import {
  objdumpInputSchema,
  radare2InputSchema,
  radiff2InputSchema,
  rizinInputSchema,
} from "../domain/reverseEngineering.js";
import type { ToolContract } from "./toolContractTypes.js";
import { evidenceResultOf } from "./toolOutputSchemaPrimitives.js";
import { analysisDetailOutputSchemaOf } from "./analysisDetail.js";
import { toolContractMetadata } from "./toolEffects.js";

/** Caller-selected GNU objdump and Rizin observations. */
export const REVERSE_ENGINEERING_TOOL_CONTRACTS = [
  {
    name: "inspect_with_objdump",
    ...toolContractMetadata("inspect_with_objdump"),
    kind: "native-provider",
    description:
      "Run caller-selected GNU objdump inspection against a local artifact, or request operation=architectures without a path to list BFD targets advertised by the installed binary. For operation=disassemble, optional symbol selects native symbol-scoped disassembly before output collection; omission preserves all code sections. Matching and symbol boundaries follow GNU objdump. Preserves decoded stdout and stderr inline with SHA-256 Evidence for artifact inspections, up to a shared 16 MiB combined limit; invalid UTF-8 bytes are represented by replacement characters and flagged in Evidence limitations. output_truncated reports output beyond that limit and completion_status is unknown if buffer enforcement terminated the process. The raw output is authoritative and REA does not claim a stable normalized format. DWARF does not follow local debug links by default. Set follow_debug_links to true to follow them; identities of external debug files are not bound to Evidence. REA clears DEBUGINFOD_URLS for objdump so DWARF processing does not make debuginfod network requests. Default detail complete returns original Evidence. Explicit detail summary retains the complete parent and returns its command observation once, without the raw mirror; parent_evidence_id supports later inspect_analysis_view summary queries and complete Evidence export. Architecture output is subjectless and does not establish support for any artifact. Optional command_timeout_ms is the per-phase wall clock in milliseconds (default 120000, range 1..2147483647); omitted means 120000 and the value applies on the next call. It does not raise the 16 MiB output cap.",
    inputSchema: objdumpInputSchema,
    outputSchema: analysisDetailOutputSchemaOf(
      commandObservationSchema,
      objdumpSummaryViewResultSchema,
    ),
    examples: [
      {
        title: "Disassemble code sections",
        input: { path: "/tmp/program", operation: "disassemble" },
      },
      {
        title: "List advertised BFD targets",
        input: { operation: "architectures" },
      },
    ],
  },
  {
    name: "execute_rizin_command",
    ...toolContractMetadata("execute_rizin_command"),
    kind: "native-provider",
    description:
      "Execute one caller-selected Rizin command against a local artifact using the Rizin CLI profile that suppresses user settings and scripts while retaining plugins. Preserves decoded stdout and stderr inline with SHA-256 Evidence, up to a shared 16 MiB combined limit; invalid UTF-8 bytes are represented by replacement characters and flagged in Evidence limitations. output_truncated reports output beyond that limit and completion_status is unknown if buffer enforcement terminated the process. Rizin commands and retained plugins can execute foreign code, mutate files, access the network, and read files outside the selected artifact; identities and contents of those external inputs are not bound to Evidence. Command effects depend on the Rizin command and loaded plugins; JSON is command-specific and raw output remains authoritative. In a shared MCP server, this admitted command closes any active binary-analysis session; after its effects have settled, call open_binary before further analysis. Close an active Ghidra session explicitly first. Optional command_timeout_ms is the per-phase wall clock in milliseconds (default 120000, range 1..2147483647); omitted means 120000 and the value applies on the next call. It does not raise the 16 MiB output cap or a Rizin debugger session deadline.",
    inputSchema: rizinInputSchema,
    outputSchema: evidenceResultOf(commandObservationSchema),
    examples: [
      {
        title: "Inspect binary information",
        input: { path: "/tmp/program", command: "iI" },
      },
    ],
  },
  {
    name: "execute_radare2_command",
    ...toolContractMetadata("execute_radare2_command"),
    kind: "native-provider",
    description:
      "Execute one caller-selected Radare2 command against a local artifact using the Radare2 CLI profile that suppresses user rcfiles while retaining plugins. Preserves decoded stdout and stderr inline with SHA-256 Evidence, up to a shared 16 MiB combined limit; invalid UTF-8 bytes are represented by replacement characters and flagged in Evidence limitations. output_truncated reports output beyond that limit and completion_status is unknown if buffer enforcement terminated the process. Radare2 commands and retained plugins can execute foreign code, mutate files, access the network, and read files outside the selected artifact; identities and contents of those external inputs are not bound to Evidence. Command effects depend on the Radare2 command and loaded plugins; JSON is command-specific and raw output remains authoritative. In a shared MCP server, this admitted command closes any active binary-analysis session; after its effects have settled, call open_binary before further analysis. Close an active Ghidra session explicitly first. Optional command_timeout_ms is the per-phase wall clock in milliseconds (default 120000, range 1..2147483647); omitted means 120000 and the value applies on the next call. It does not raise the 16 MiB output cap.",
    inputSchema: radare2InputSchema,
    outputSchema: evidenceResultOf(commandObservationSchema),
    examples: [
      {
        title: "Inspect binary information as JSON",
        input: { path: "/tmp/program", command: "ij" },
      },
    ],
  },
  {
    name: "compare_with_radiff2",
    ...toolContractMetadata("compare_with_radiff2"),
    kind: "native-provider",
    description:
      "Compare two local artifacts with the caller-supplied radiff2 tool. `operation: functions` maps to `-Cj -A` and returns radiff2's function-level diff as JSON in stdout; `operation: bytes` maps to `-A` and returns the byte-level diff text. The comparison is read-only and offers no arbitrary-command surface. Evidence digests cover `path_a` only; `path_b` is preserved as the caller-selected path and its identity is not digest-bound. Preserves decoded stdout and stderr inline, up to a shared 16 MiB combined limit; output_truncated reports output beyond that limit and completion_status is unknown if buffer enforcement terminated the process. JSON is radiff2-version-specific and raw output remains authoritative. The comparison neither reads nor alters the active analysis session, so an open target stays usable after it returns. Optional command_timeout_ms is the per-phase wall clock in milliseconds (default 120000, range 1..2147483647); omitted means 120000 and the value applies on the next call. It does not raise the 16 MiB output cap.",
    inputSchema: radiff2InputSchema,
    outputSchema: evidenceResultOf(commandObservationSchema),
    examples: [
      {
        title: "Compare function-level differences",
        input: {
          path_a: "/tmp/program-a",
          path_b: "/tmp/program-b",
          operation: "functions",
        },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
