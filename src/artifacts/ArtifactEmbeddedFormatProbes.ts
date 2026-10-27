import type {
  StableRegularFileDescriptor,
  RegularFileState,
} from "../filesystem/RegularFile.js";
import {
  regularFileState,
  sameRegularFileState,
} from "../filesystem/RegularFile.js";
import { ArtifactReaderFailure } from "./ArtifactReader.js";
import { abortIfNeeded } from "./ArtifactHash.js";
import { locateGodotPck, type GodotPckLocation } from "./GodotPckLocation.js";
import {
  locateNodeSea,
  type NodeSeaLocation,
} from "./nodeSea/NodeSeaLocation.js";
import {
  findPyInstallerCookie,
  type PyInstallerCookie,
} from "./pyinstaller/CArchiveLayout.js";

/** Completed observations only; null means examined absence, omission means unexamined. */
export interface ArtifactEmbeddedFormatProbeFacts {
  readonly sourceState: RegularFileState;
  readonly godotPck?: GodotPckLocation | null;
  readonly nodeSea?: NodeSeaLocation | null;
  readonly pyInstaller?: PyInstallerCookie | null;
}

/** Share format observations only across admissions of the same unchanged regular file. */
export class ArtifactEmbeddedFormatProbes {
  #facts: ArtifactEmbeddedFormatProbeFacts;

  constructor(
    path: string,
    private readonly source: StableRegularFileDescriptor,
    private readonly signal?: AbortSignal,
    previous?: ArtifactEmbeddedFormatProbeFacts,
  ) {
    abortIfNeeded(signal);
    if (
      previous !== undefined &&
      !sameRegularFileState(previous.sourceState, source.initial)
    )
      throw new ArtifactReaderFailure(
        "integrity",
        `Root artifact changed before inventory: ${path}`,
      );
    this.#facts = previous ?? { sourceState: regularFileState(source.initial) };
  }

  async godotPck(prefix?: Uint8Array): Promise<GodotPckLocation | undefined> {
    abortIfNeeded(this.signal);
    if (this.#facts.godotPck !== undefined)
      return this.#facts.godotPck ?? undefined;
    const location = await locateGodotPck(
      this.source.handle,
      this.source.initial.size,
      this.signal,
      prefix,
    );
    this.#facts = { ...this.#facts, godotPck: location ?? null };
    return location;
  }

  async nodeSea(): Promise<NodeSeaLocation | undefined> {
    abortIfNeeded(this.signal);
    if (this.#facts.nodeSea !== undefined)
      return this.#facts.nodeSea ?? undefined;
    const location = await locateNodeSea(
      this.source.handle,
      this.source.initial.size,
      this.signal,
    );
    this.#facts = { ...this.#facts, nodeSea: location ?? null };
    return location;
  }

  async pyInstaller(): Promise<PyInstallerCookie | undefined> {
    abortIfNeeded(this.signal);
    if (this.#facts.pyInstaller !== undefined)
      return this.#facts.pyInstaller ?? undefined;
    const found = await findPyInstallerCookie(
      this.source.handle,
      this.source.initial.size,
      this.signal,
    );
    abortIfNeeded(this.signal);
    const cookie = found?.ok === true ? found.value : undefined;
    this.#facts = { ...this.#facts, pyInstaller: cookie ?? null };
    return cookie;
  }

  completedFacts(): ArtifactEmbeddedFormatProbeFacts {
    return this.#facts;
  }
}
