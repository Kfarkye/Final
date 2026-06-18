import { Spanner } from "@google-cloud/spanner";
import { env } from "../config/env";

export const spannerClient = new Spanner({ projectId: env.SPANNER_PROJECT_ID });
export const edgeDb = spannerClient.instance("clearspace").database("sports-mlb-db");
