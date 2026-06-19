      // ── COMMIT with optimistic concurrency ───────────────────────
      try {
        const committed = await this.store.commitDelta(merged, baseRev, requestId);
        return { artifact: committed, results };
      } catch (e) {
        if (e instanceof RevConflict && attempt < this.opts.commitRetries) {
          console.log(
  async execute(
    artifactId: string,
    plan: PlanItem[],
    requestId?: string
  ): Promise<{ artifact: Artifact; results: AgentResult[] }> {

    for (let attempt = 0; attempt <= this.opts.commitRetries; attempt++) {
      const artifact = await this.store.load(artifactId);
      if (!artifact) throw new Error(`Artifact not found: ${artifactId}`);
      // ── COMMIT with optimistic concurrency ───────────────────────
      try {
        const committed = await this.store.commitDelta(merged, baseRev, requestId);
        return { artifact: committed, results };
      } catch (e) {
        if (e instanceof RevConflict && attempt < this.opts.commitRetries) {
          console.log(
  async execute(
    artifactId: string,
    plan: PlanItem[],
    requestId?: string
  ): Promise<{ artifact: Artifact; results: AgentResult[] }> {

    for (let attempt = 0; attempt <= this.opts.commitRetries; attempt++) {
      const artifact = await this.store.load(artifactId);
      if (!artifact) throw new Error(`Artifact not found: ${artifactId}`);