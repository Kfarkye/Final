export interface ArtifactStore {
  /** Load an artifact by ID, assembling from row-level blocks. Returns null if not found. */
  load(id: string): Promise<Artifact | null>;

  /**
   * Commit delta patches to an artifact.
   * Uses compare-and-swap: if the current rev doesn't match expectedRev,
   * throws RevConflict so the caller can reload and retry.
   * Includes idempotency protection via requestId.
export interface ArtifactStore {
  /** Load an artifact by ID, assembling from row-level blocks. Returns null if not found. */
  load(id: string): Promise<Artifact | null>;

  /**
   * Commit delta patches to an artifact.
   * Uses compare-and-swap: if the current rev doesn't match expectedRev,
   * throws RevConflict so the caller can reload and retry.
   * Includes idempotency protection via requestId.
   */
  commitDelta(
    next: Artifact,
    expectedRev: number,
    requestId?: string
  ): Promise<Artifact>;

  /** Create a new artifact. Throws if it already exists. */
  create(a: Artifact): Promise<Artifact>;

  /** Load revision history for an artifact. Returns snapshots newest-first. */
  loadHistory?(id: string, limit?: number): Promise<LedgerEntry[]>;
}

/** A single historical snapshot of an artifact revision */
export interface LedgerEntry {
  artifact_id: string;
  rev: number;
  snapshot: Artifact;
  committed_at: string;
}