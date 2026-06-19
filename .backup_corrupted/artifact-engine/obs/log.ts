import { logger } from "../../utils/logger";

// ============================================================================
// Artifact Engine — Structured Logger
// ============================================================================
// Child logger scoped to the artifact engine. All artifact-engine code should
// use this instead of console.* for structured, traceable output.
// ============================================================================

export const log = logger.child({ component: "artifact-engine" });
