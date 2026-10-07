import {
  createJavaScriptApplicationEdge,
  createJavaScriptApplicationNode,
  type ApplicationEdge,
  type ApplicationNode,
} from "../domain/javascriptApplicationGraph.js";
import { javascriptDisplayText } from "../domain/javascriptAstValues.js";

/** Deduplicate graph entities while retaining distinct evidence observations. */
export class JavaScriptArtifactGraphAccumulator {
  readonly #nodes = new Map<string, ApplicationNode>();
  readonly #edges = new Map<string, ApplicationEdge>();

  /** Create or merge one canonical node. */
  addNode<Input extends DisplayableNodeInput>(input: Input): ApplicationNode {
    const created = createJavaScriptApplicationNode(displayableNode(input));
    const existing = this.#nodes.get(created.node_id);
    if (existing === undefined) {
      this.#nodes.set(created.node_id, created);
      return created;
    }
    const bySemanticId = new Map(
      [...existing.observations, ...created.observations].map((observation) => [
        observation.observation_id,
        observationInput(observation),
      ]),
    );
    const observations = [...bySemanticId.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([, observation]) => observation);
    const merged = createJavaScriptApplicationNode({
      kind: existing.kind,
      identity: existing.identity,
      observations,
    });
    this.#nodes.set(merged.node_id, merged);
    return merged;
  }

  /** Create or replace one canonical edge by semantic identifier. */
  addEdge(input: unknown): ApplicationEdge {
    const edge = createJavaScriptApplicationEdge(input);
    this.#edges.set(edge.edge_id, edge);
    return edge;
  }

  /** Return all accumulated canonical nodes. */
  nodes(): readonly ApplicationNode[] {
    return [...this.#nodes.values()];
  }

  /** Return all accumulated canonical edges. */
  edges(): readonly ApplicationEdge[] {
    return [...this.#edges.values()];
  }
}

const observationInput = (
  observation: ApplicationNode["observations"][number],
) => {
  const {
    observation_id: _observationId,
    identifier_strategy: _strategy,
    ...input
  } = observation;
  return input;
};

/** Node fields whose display form is normalized before validation. */
interface DisplayableNodeInput {
  readonly identity: { readonly strategy: string; readonly key?: string };
  readonly observations: readonly { readonly label: string | null }[];
}

/**
 * Static findings can carry legal empty strings, such as `fetch("")` or
 * `require("")`. Labels and artifact-local keys must be nonempty, so display
 * the empty value as `""`; each observation keeps the exact value in its
 * properties.
 */
const displayableNode = (
  input: DisplayableNodeInput,
): DisplayableNodeInput => ({
  ...input,
  identity:
    input.identity.strategy === "artifact-local-key" &&
    input.identity.key !== undefined
      ? { ...input.identity, key: javascriptDisplayText(input.identity.key) }
      : input.identity,
  observations: input.observations.map((observation) => ({
    ...observation,
    label:
      observation.label === null
        ? null
        : javascriptDisplayText(observation.label),
  })),
});
