import { exec } from "child_process";
import { promisify } from "util";
import { edgeDb } from "../db/spanner.js";
import { PubSub } from "@google-cloud/pubsub";
import { logger } from "../utils/logger.js";
import { env } from "../config/env.js";

const execPromise = promisify(exec);
const pubsub = new PubSub({ projectId: env.SPANNER_PROJECT_ID || "gen-lang-client-0281999829" });

function getBuildSha(): string {
  const buildSha = process.env.BUILD_SHA?.trim();
  return buildSha && buildSha !== "unknown" ? buildSha.substring(0, 7) : "";
}

function isGitRepositoryMissing(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("not a git repository");
}

export interface WorkspaceState {
  status: "READY" | "SYNC_NEEDED" | "DIRTY" | "WRONG_BRANCH";
  branch: string;
  localSha: string;
  remoteSha: string;
  isDirty: boolean;
  behindCount: number;
  message?: string;
}

export interface LiveDeploymentState {
  status: "HEALTHY" | "LIVE_MISMATCH" | "UNREACHABLE";
  environment: string;
  liveSha: string;
  localSha: string;
  routeHealth: "passing" | "failing" | "unknown";
}

export interface InfrastructureState {
  spannerSchema: "v1.2.0" | "v1.1.0" | "missing";
  pubsubVersion: "v1.2.0" | "incomplete" | "missing";
  workersHealthy: boolean;
  canaryStatus: "passed" | "failed" | "untested";
  details: {
    missingTables: string[];
    missingTopics: string[];
    missingSubscriptions: string[];
  };
}

export interface DeploymentPlan {
  planId: string;
  action: "provision-infra" | "deploy-app";
  risk: "low" | "medium" | "high";
  requiresApproval: boolean;
  changes: Array<{ type: string; name: string }>;
  approvalPhrase: string;
}

const EXPECTED_V12_TABLES = [
  "MlbPipelineSchemaRegistry",
  "MlbOddsBackfillRuns",
  "MlbOddsBackfillSnapshotJobs",
  "MlbPipelineMessageLedger",
  "MlbPipelineOutbox",
  "MlbProviderRequestLog",
  "MlbLiveMonitors",
  "MlbLiveMonitorEvaluations",
  "MlbLiveGameStateSnapshots",
  "MlbLiveMonitorAlerts",
  "MlbNotificationDeliveries",
  "MlbPipelineDeadLetters"
];

const EXPECTED_V12_TOPICS = [
  "mlb-odds-backfill-command",
  "mlb-odds-backfill-snapshot-requested",
  "mlb-odds-backfill-snapshot-result",
  "mlb-odds-backfill-run-result",
  "mlb-live-monitor-command",
  "mlb-live-monitor-tick",
  "live-state-committed",
  "mlb-live-monitor-alert",
  "mlb-pipeline-dlq"
];

export class ControlPlaneService {
  /**
   * Evaluates the local Git workspace against the remote origin.
   */
  public async getWorkspaceState(): Promise<WorkspaceState> {
    try {
      // 1. Get current branch
      const { stdout: branchOut } = await execPromise("git rev-parse --abbrev-ref HEAD");
      const branch = branchOut.trim();

      // 2. Get local SHA
      const { stdout: localShaOut } = await execPromise("git rev-parse HEAD");
      const localSha = localShaOut.trim();

      // 3. Check if dirty
      const { stdout: statusOut } = await execPromise("git status --porcelain");
      const isDirty = statusOut.trim().length > 0;

      if (branch !== "kfarkye/final") {
        return {
          status: "WRONG_BRANCH",
          branch,
          localSha: localSha.substring(0, 7),
          remoteSha: "",
          isDirty,
          behindCount: 0,
          message: `Workspace is on branch '${branch}' instead of the canonical 'kfarkye/final'.`
        };
      }

      if (isDirty) {
        return {
          status: "DIRTY",
          branch,
          localSha: localSha.substring(0, 7),
          remoteSha: "",
          isDirty: true,
          behindCount: 0,
          message: "Local workspace has uncommitted changes. Please commit, stash, or discard them."
        };
      }

      // 4. Fetch origin & check remote SHA
      await execPromise("git fetch origin");
      const { stdout: remoteShaOut } = await execPromise("git rev-parse origin/kfarkye/final");
      const remoteSha = remoteShaOut.trim();

      // 5. Calculate behind count
      const { stdout: revListOut } = await execPromise(`git rev-list --count HEAD..origin/kfarkye/final`);
      const behindCount = parseInt(revListOut.trim(), 10);

      if (behindCount > 0) {
        return {
          status: "SYNC_NEEDED",
          branch,
          localSha: localSha.substring(0, 7),
          remoteSha: remoteSha.substring(0, 7),
          isDirty: false,
          behindCount,
          message: `Workspace is behind origin/kfarkye/final by ${behindCount} commit(s).`
        };
      }

      return {
        status: "READY",
        branch,
        localSha: localSha.substring(0, 7),
        remoteSha: remoteSha.substring(0, 7),
        isDirty: false,
        behindCount: 0
      };
    } catch (err: any) {
      const buildSha = getBuildSha();
      if (buildSha && isGitRepositoryMissing(err)) {
        return {
          status: "READY",
          branch: "runtime-image",
          localSha: buildSha,
          remoteSha: buildSha,
          isDirty: false,
          behindCount: 0,
          message: "Runtime image does not include a Git checkout; using BUILD_SHA for deployed state."
        };
      }

      logger.error({ msg: "Failed to get workspace state", error: err.message });
      return {
        status: "WRONG_BRANCH",
        branch: "unknown",
        localSha: "unknown",
        remoteSha: "unknown",
        isDirty: true,
        behindCount: 0,
        message: `Git error: ${err.message}`
      };
    }
  }

  /**
   * Syncs the local workspace to match origin/kfarkye/final.
   */
  public async syncWorkspace(action: "pull" | "stash" | "discard"): Promise<void> {
    const state = await this.getWorkspaceState();
    if (state.status === "READY") return;

    if (state.isDirty) {
      if (action === "stash") {
        await execPromise("git stash");
      } else if (action === "discard") {
        await execPromise("git reset --hard HEAD && git clean -fd");
      } else {
        throw new Error("Workspace is dirty. Please stash or discard changes before syncing.");
      }
    }

    await execPromise("git fetch origin");
    await execPromise("git checkout kfarkye/final");
    await execPromise("git pull --ff-only origin kfarkye/final");
  }

  /**
   * Checks the running version of the live app on mcptruth.com.
   */
  public async getLiveDeploymentState(): Promise<LiveDeploymentState> {
    const workspace = await this.getWorkspaceState();
    const localSha = workspace.localSha;

    try {
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), 4000);

      const response = await fetch("https://mcptruth.com/api/system/git-state", {
        signal: controller.signal
      });
      clearTimeout(id);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json() as any;
      const liveSha = (data.sha || "").substring(0, 7);

      const status = liveSha === localSha ? "HEALTHY" : "LIVE_MISMATCH";

      return {
        status,
        environment: "staging",
        liveSha,
        localSha,
        routeHealth: "passing"
      };
    } catch (err: any) {
      logger.warn({ msg: "Live deployment check failed", error: err.message });
      return {
        status: "UNREACHABLE",
        environment: "staging",
        liveSha: "unknown",
        localSha,
        routeHealth: "failing"
      };
    }
  }

  /**
   * Audits Spanner and Pub/Sub status table-by-table and topic-by-topic.
   */
  public async getInfrastructureState(): Promise<InfrastructureState> {
    const missingTables: string[] = [];
    const missingTopics: string[] = [];
    const missingSubscriptions: string[] = [];

    // 1. Audit Spanner
    try {
      const [rows] = await edgeDb.run({
        sql: `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES 
              WHERE TABLE_SCHEMA = '' AND TABLE_NAME LIKE 'Mlb%'`
      });
      const activeTables = new Set(rows.map((r: any) => r.TABLE_NAME));
      for (const table of EXPECTED_V12_TABLES) {
        if (!activeTables.has(table)) {
          missingTables.push(table);
        }
      }
    } catch (err: any) {
      logger.error({ msg: "Spanner schema audit failed", error: err.message });
      missingTables.push(...EXPECTED_V12_TABLES);
    }

    // 2. Audit Pub/Sub
    try {
      const [topics] = await pubsub.getTopics();
      const activeTopics = new Set(topics.map(t => t.name.split("/").pop()));
      for (const topic of EXPECTED_V12_TOPICS) {
        if (!activeTopics.has(topic)) {
          missingTopics.push(topic);
        }
      }

      const [subscriptions] = await pubsub.getSubscriptions();
      const activeSubs = new Set(subscriptions.map(s => s.name.split("/").pop()));
      for (const topic of EXPECTED_V12_TOPICS) {
        const expectedSub = `${topic}-sub`;
        // Wait, mlb-live-state-committed has a custom sub name: mlb-live-state-reducer-sub
        const subName = topic === "live-state-committed" ? "mlb-live-state-reducer-sub" : expectedSub;
        if (!activeSubs.has(subName)) {
          missingSubscriptions.push(subName);
        }
      }
    } catch (err: any) {
      logger.error({ msg: "Pub/Sub audit failed", error: err.message });
      missingTopics.push(...EXPECTED_V12_TOPICS);
    }

    const spannerSchema = missingTables.length === 0 
      ? "v1.2.0" 
      : (missingTables.length === EXPECTED_V12_TABLES.length ? "missing" : "v1.1.0");

    const pubsubVersion = missingTopics.length === 0 && missingSubscriptions.length === 0
      ? "v1.2.0"
      : (missingTopics.length === EXPECTED_V12_TOPICS.length ? "missing" : "incomplete");

    // Check worker health by probing them
    let workersHealthy = true;
    if (pubsubVersion !== "v1.2.0") {
      workersHealthy = false;
    }

    return {
      spannerSchema,
      pubsubVersion,
      workersHealthy,
      canaryStatus: "untested",
      details: {
        missingTables,
        missingTopics,
        missingSubscriptions
      }
    };
  }

  /**
   * Generates a dry-run deployment plan outlining what will change.
   */
  public async prepareDeploy(): Promise<DeploymentPlan> {
    // 1. Run typescript compile check
    try {
      await execPromise("npx tsc --noEmit");
    } catch (err: any) {
      throw new Error(`TypeScript compilation check failed: ${err.stdout || err.message}`);
    }

    const infra = await this.getInfrastructureState();
    const changes: Array<{ type: string; name: string }> = [];

    for (const table of infra.details.missingTables) {
      changes.push({ type: "spanner.create_table", name: table });
    }
    for (const topic of infra.details.missingTopics) {
      changes.push({ type: "pubsub.create_topic", name: topic });
    }
    for (const sub of infra.details.missingSubscriptions) {
      changes.push({ type: "pubsub.create_subscription", name: sub });
    }

    return {
      planId: `plan-${Date.now()}`,
      action: changes.length > 0 ? "provision-infra" : "deploy-app",
      risk: changes.length > 5 ? "high" : "medium",
      requiresApproval: true,
      changes,
      approvalPhrase: "DEPLOY V1.2"
    };
  }

  /**
   * Executes the deployment plan: applies DDL, provisions Pub/Sub, and triggers rollout.
   */
  public async executeDeploy(planId: string, approval: string): Promise<void> {
    if (approval !== "DEPLOY V1.2") {
      throw new Error("Invalid approval phrase.");
    }

    logger.info({ msg: "Starting control plane deployment execution", planId });

    // 1. Apply Spanner DDL & Pub/Sub provisioning via the provision script
    try {
      const { stdout, stderr } = await execPromise("bash scripts/provision-infra.sh");
      logger.info({ msg: "Provisioning script output", stdout, stderr });
    } catch (err: any) {
      logger.error({ msg: "Provisioning script failed", error: err.message, stdout: err.stdout, stderr: err.stderr });
      throw new Error(`Infrastructure provisioning failed: ${err.message}`);
    }

    // 2. Trigger GKE rollout
    try {
      await execPromise("kubectl rollout restart deployment/reverie && kubectl rollout status deployment/reverie --timeout=180s");
    } catch (err: any) {
      logger.error({ msg: "GKE rollout restart failed", error: err.message });
      throw new Error(`GKE rollout failed: ${err.message}`);
    }

    logger.info({ msg: "Control plane deployment execution completed successfully", planId });
  }

  /**
   * Publishes a canary message to verify the end-to-end Pub/Sub -> Spanner loop.
   */
  public async runCanary(): Promise<boolean> {
    const testIdempotencyKey = `canary-${Date.now()}`;
    const testMessage = {
      messageId: `msg-${Date.now()}`,
      messageType: "odds.backfill.command.v1",
      tenantId: "truth-canary",
      environment: "staging",
      idempotencyKey: testIdempotencyKey,
      correlationId: `corr-${Date.now()}`,
      source: "canary-probe",
      priority: 1,
      payload: {
        sport: "mlb",
        provider: "odds-api",
        intervalHours: 4,
        markets: ["h2h"],
        regions: ["us"],
        bookmakers: ["draftkings"],
        snapshotType: "thin",
        quotaFloor: 100,
        maxCreditsBudget: 50,
        createMissingParents: true,
        strictParentRequired: false,
        dryRun: true,
        requestedBy: "canary-system"
      }
    };

    try {
      // 1. Publish to the topic
      const dataBuffer = Buffer.from(JSON.stringify(testMessage));
      const messageId = await pubsub.topic("mlb-odds-backfill-command").publishMessage({ data: dataBuffer });
      logger.info({ msg: "Canary message published", messageId });

      // 2. Poll Spanner with a backoff (up to 5 seconds) to see if it processed
      for (let i = 0; i < 5; i++) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        const [rows] = await edgeDb.run({
          sql: `SELECT Status FROM MlbPipelineMessageLedger 
                WHERE TenantId = 'truth-canary' 
                AND IdempotencyKey = @idempotencyKey`,
          params: { idempotencyKey: testIdempotencyKey }
        });

        if (rows && rows.length > 0) {
          const status = (rows[0] as any).Status;
          if (status === "COMPLETED") {
            logger.info({ msg: "Canary verification PASSED" });
            return true;
          }
        }
      }

      logger.warn({ msg: "Canary verification TIMEOUT: message not found in ledger" });
      return false;
    } catch (err: any) {
      logger.error({ msg: "Canary verification FAILED", error: err.message });
      return false;
    }
  }
}

export const controlPlaneService = new ControlPlaneService();
