import { canonicalJson } from "./comparisonSemantics.js";
import type { FunctionSnapshot } from "./functionDossierEvidence.js";
import { isAutoName } from "./functionComparisonNormalization.js";
import { nativeAddressInputSchema } from "./native/nativeAddress.js";

type Procedure = FunctionSnapshot["dossier"]["callers"][number];

export type FunctionEndpoint =
  | { readonly kind: "address"; readonly address: string }
  | {
      readonly kind: "name";
      readonly name: string;
      readonly ambiguous: boolean;
    }
  | {
      readonly kind: "unknown";
      readonly reason: "unparsed_address" | "missing_name" | "generated_name";
      readonly reported_address: string;
      readonly reported_name: string | null;
    };

export interface FunctionEndpointIdentity {
  readonly sameArtifact: boolean;
  readonly endpoint: (
    procedure: Procedure | null,
    address: string,
  ) => FunctionEndpoint;
}

/** Observe all retained procedure entries before using names as cross-artifact keys. */
const ambiguousProcedureNames = (
  snapshots: readonly FunctionSnapshot[],
): Set<string> => {
  const ambiguous = new Set<string>();
  for (const snapshot of snapshots) {
    const entries = new Map<string, string>();
    const observe = (procedure: Procedure | null): void => {
      if (procedure === null) return;
      const address = nativeAddressInputSchema.safeParse(procedure.address);
      if (!address.success) {
        ambiguous.add(procedure.name);
        return;
      }
      const previous = entries.get(procedure.name);
      if (previous !== undefined && previous !== address.data)
        ambiguous.add(procedure.name);
      entries.set(procedure.name, address.data);
    };
    observe(snapshot.dossier.procedure);
    for (const procedure of snapshot.dossier.callers) observe(procedure);
    for (const procedure of snapshot.dossier.callees) observe(procedure);
    for (const edge of snapshot.dossier.incoming_references) {
      observe(edge.source_procedure);
      observe(edge.target_procedure);
    }
    for (const edge of snapshot.dossier.outgoing_references) {
      observe(edge.source_procedure);
      observe(edge.target_procedure);
    }
  }
  return ambiguous;
};

/** Calls use procedure entries; references supply their exact observed site coordinates. */
export const functionEndpointIdentity = (
  left: FunctionSnapshot,
  right: FunctionSnapshot,
): FunctionEndpointIdentity => {
  const sameArtifact =
    left.subject.digest.sha256 === right.subject.digest.sha256;
  const ambiguousNames = sameArtifact
    ? new Set<string>()
    : ambiguousProcedureNames([left, right]);
  return {
    sameArtifact,
    endpoint: (procedure, address) => {
      if (sameArtifact) {
        const parsed = nativeAddressInputSchema.safeParse(address);
        if (parsed.success) return { kind: "address", address: parsed.data };
        return {
          kind: "unknown",
          reason: "unparsed_address",
          reported_address: address,
          reported_name: procedure?.name ?? null,
        };
      }
      if (
        procedure === null ||
        procedure.name.length === 0 ||
        isAutoName(procedure.name)
      )
        return {
          kind: "unknown",
          reason:
            procedure !== null && isAutoName(procedure.name)
              ? "generated_name"
              : "missing_name",
          reported_address: address,
          reported_name: procedure?.name ?? null,
        };
      return {
        kind: "name",
        name: procedure.name,
        ambiguous: ambiguousNames.has(procedure.name),
      };
    },
  };
};

/** Ambiguity blocks equality, but a known label can still contradict another label. */
export const functionEndpointKey = (value: FunctionEndpoint): string | null => {
  if (value.kind === "unknown") return null;
  return canonicalJson(
    value.kind === "address"
      ? { address: value.address }
      : { name: value.name },
  );
};
