  async commit(next: Artifact, expectedRev: number): Promise<Artifact> {
    const current = this.store.get(next.artifact_id);
    const currentRev = current?.rev ?? 0;
    if (currentRev !== expectedRev) {
      throw new RevConflict(expectedRev, currentRev);
    }
    const committed = structuredClone(next);
    this.store.set(next.artifact_id, committed);
    return committed;
  }

  async commitDelta(next: Artifact, expectedRev: number, _requestId?: string): Promise<Artifact> {
    return this.commit(next, expectedRev);
  }