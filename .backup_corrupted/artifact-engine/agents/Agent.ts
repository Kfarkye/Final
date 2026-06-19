export type AgentDomain = "standings" | "odds" | "form" | "squad" | "venues" | "matches";

export interface Agent {
  /** Domain name this agent owns, e.g. "standings", "odds" */
  domain: AgentDomain;
  /** Execute the agent — must be pure and deterministic for a given input */
  run(task: AgentTask, deps: AgentDeps): Promise<AgentResult>;
}