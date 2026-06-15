import { env } from "./config/env";

// Re-export validated configuration as 'config' for backwards compatibility
export const config = env;
