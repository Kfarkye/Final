import dotenv from "dotenv";
import { z } from "zod";

// Load variables from .env file (ignored in production environments where K8s/Docker provides them)
dotenv.config();

const envSchema = z.object({
  // Server Configuration
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  
  // Database Configuration
  SQL_HOST: z.string().optional(),
  SQL_USER: z.string().optional(),
  SQL_PASSWORD: z.string().optional(),
  SQL_DB_NAME: z.string().optional(),
  DATABASE_URL: z.string().url("DATABASE_URL must be a valid connection string").optional(),

  // Cloud & Vertex AI Requirements
  GCP_PROJECT: z.string().min(1, "GCP Project ID is required for Vertex AI integration"),
  GCP_LOCATION: z.string().default("global"),

  // Optional External LLM Keys
  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  XAI_API_KEY: z.string().optional(),
  DEEPSEEK_API_KEY: z.string().optional(),
  DEEPSEEK_API_BASE_URL: z.string().default("https://api.deepseek.com"),

  // Cloud Spanner Configuration
  SPANNER_PROJECT_ID: z.string().optional(),
  SPANNER_INSTANCE_ID: z.string().optional(),
  SPANNER_DATABASE_ID: z.string().optional(),
});

// 🛡️ Evaluate the environment immediately
const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  console.error("❌ Invalid or missing environment variables:");
  parsedEnv.error.issues.forEach((issue) => {
    console.error(`   - ${issue.path.join(".")}: ${issue.message}`);
  });
  
  // FAIL-FAST: Crash the process immediately with a non-zero exit code
  process.exit(1); 
}

// Support GCP_PROJECT_ID alias to align with K8s standard/user request
const configWithAliases = {
  ...parsedEnv.data,
  GCP_PROJECT_ID: parsedEnv.data.GCP_PROJECT,
  SPANNER_PROJECT_ID: parsedEnv.data.SPANNER_PROJECT_ID || parsedEnv.data.GCP_PROJECT,
  SPANNER_INSTANCE_ID: parsedEnv.data.SPANNER_INSTANCE_ID || "",
  SPANNER_DATABASE_ID: parsedEnv.data.SPANNER_DATABASE_ID || "",
};

// Export a frozen, strictly-typed configuration object (Object.freeze prevents runtime mutations)
export const env = Object.freeze(configWithAliases);
