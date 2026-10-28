import type { EvidenceProvider } from "../../domain/evidence.js";
import type {
  ObjdumpSelection,
  Radare2Input,
  Radiff2Input,
  RizinInput,
} from "../../domain/reverseEngineering.js";

/** Provider-neutral command profile consumed by the shared application workflow. */
export interface ReverseEngineeringProviderCommand {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly identity: EvidenceProvider;
  readonly environmentOverrides?: Readonly<NodeJS.ProcessEnv>;
}

/** Provider-specific command construction stays outside the application layer. */
export interface ReverseEngineeringCommandPort {
  objdump(input: ObjdumpSelection): ReverseEngineeringProviderCommand;
  rizin(input: RizinInput): ReverseEngineeringProviderCommand;
  radare2(input: Radare2Input): ReverseEngineeringProviderCommand;
  radiff2(input: Radiff2Input): ReverseEngineeringProviderCommand;
}
