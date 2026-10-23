import { canonicalJson } from "./comparisonSemantics.js";
import type { FunctionSnapshot } from "./functionDossierEvidence.js";
import { sorted } from "./functionComparisonNormalization.js";
import {
  referenceFactsCompatible,
  type ReferenceCompatibilityRow,
} from "./functionReferenceCompatibility.js";
import {
  functionEndpointKey,
  type FunctionEndpoint,
  type FunctionEndpointIdentity,
} from "./functionEndpointIdentity.js";

type Reference = FunctionSnapshot["dossier"]["outgoing_references"][number];
type KnownKind = Omit<
  Extract<Reference["kind"], { available: true }>,
  "available" | "provenance"
>;

interface ReferenceFact {
  readonly direction: "in" | "out";
  readonly source: FunctionEndpoint;
  readonly target: FunctionEndpoint;
  readonly kind: KnownKind | null;
}

type ReferenceComparison = {
  readonly leftCount: number;
  readonly rightCount: number;
  readonly limitations: readonly string[];
} & (
  | { readonly status: "unknown" }
  | {
      readonly status: "changed" | "unchanged";
      readonly left: readonly ReferenceFact[];
      readonly right: readonly ReferenceFact[];
    }
);

const project = (
  snapshot: FunctionSnapshot,
  identity: FunctionEndpointIdentity,
): ReferenceFact[] => {
  const facts: ReferenceFact[] = [];
  const collect = (
    references: readonly Reference[],
    direction: "in" | "out",
  ): void => {
    for (const edge of references) {
      let kind: KnownKind | null = null;
      if (edge.kind.available) {
        const {
          available: _available,
          provenance: _provenance,
          ...known
        } = edge.kind;
        kind = known;
      }
      facts.push({
        direction,
        source: identity.endpoint(edge.source_procedure, edge.source_address),
        target: identity.endpoint(edge.target_procedure, edge.target_address),
        kind,
      });
    }
  };
  collect(snapshot.dossier.incoming_references, "in");
  collect(snapshot.dossier.outgoing_references, "out");
  return facts;
};

const constraints = (
  facts: readonly ReferenceFact[],
): ReferenceCompatibilityRow[] =>
  facts.map((fact) => ({
    direction: fact.direction,
    source: functionEndpointKey(fact.source),
    target: functionEndpointKey(fact.target),
    kind: fact.kind === null ? null : canonicalJson(fact.kind),
  }));

/** Compare parsed endpoint and kind facts without replacing partial knowledge with absence. */
export const compareFunctionReferences = (
  left: FunctionSnapshot,
  right: FunctionSnapshot,
  identity: FunctionEndpointIdentity,
): ReferenceComparison => {
  const leftFacts = project(left, identity);
  const rightFacts = project(right, identity);
  let unknownIdentity = false;
  let ambiguousIdentity = false;
  let unknownKinds = false;
  for (const facts of [leftFacts, rightFacts]) {
    for (const fact of facts) {
      unknownKinds ||= fact.kind === null;
      for (const value of [fact.source, fact.target]) {
        unknownIdentity ||= value.kind === "unknown";
        ambiguousIdentity ||= value.kind === "name" && value.ambiguous;
      }
    }
  }
  const limitations: string[] = [];
  if (unknownIdentity)
    limitations.push(
      identity.sameArtifact
        ? "Reference endpoint coordinates could not be parsed, so their identity remains unknown."
        : "Unnamed reference endpoints and generated procedure names have no stable identity across different artifacts.",
    );
  if (ambiguousIdentity)
    limitations.push(
      "A reference name does not uniquely identify an observed procedure entry, so matching names do not establish equal endpoints.",
    );
  if (unknownKinds)
    limitations.push(
      "At least one provider did not expose reference kinds, so compatible endpoints do not prove equal edge semantics.",
    );
  const context = {
    leftCount: leftFacts.length,
    rightCount: rightFacts.length,
    limitations,
  };
  if (
    !referenceFactsCompatible(constraints(leftFacts), constraints(rightFacts))
  )
    return {
      ...context,
      status: "changed",
      left: sorted(leftFacts),
      right: sorted(rightFacts),
      limitations: [
        "Known reference facts cannot be paired without contradicting an endpoint or reference kind.",
        ...limitations,
      ],
    };
  if (unknownIdentity || ambiguousIdentity || unknownKinds)
    return { ...context, status: "unknown" };
  return {
    ...context,
    status: "unchanged",
    left: sorted(leftFacts),
    right: sorted(rightFacts),
  };
};
