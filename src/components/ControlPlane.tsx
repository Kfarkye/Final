import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { 
  Shield, GitBranch, RefreshCw, Layers, Zap, CheckCircle2, 
  AlertTriangle, Play, Check, ChevronRight, HardDrive, Terminal
} from "lucide-react";

interface StatusResponse {
  status: "READY" | "SYNC_NEEDED" | "DIRTY" | "WRONG_BRANCH" | "LIVE_MISMATCH";
  workspace: {
    status: string;
    branch: string;
    localSha: string;
    remoteSha: string;
    isDirty: boolean;
    behindCount: number;
    message?: string;
  };
  live: {
    status: string;
    environment: string;
    liveSha: string;
    localSha: string;
    routeHealth: string;
  };
  infra: {
    spannerSchema: string;
    pubsubVersion: string;
    workersHealthy: boolean;
    canaryStatus: string;
    details: {
      missingTables: string[];
      missingTopics: string[];
      missingSubscriptions: string[];
    };
  };
}

interface DeploymentPlan {
  planId: string;
  action: string;
  risk: string;
  requiresApproval: boolean;
  changes: Array<{ type: string; name: string }>;
  approvalPhrase: string;
}

export default function ControlPlane() {
  const [data, setData] = useState<StatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [plan, setPlan] = useState<DeploymentPlan | null>(null);
  const [approvalInput, setApprovalInput] = useState("");
  const [consoleMsg, setConsoleMsg] = useState<string | null>(null);

  const fetchStatus = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/control-plane/status");
      if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
      const json = await res.json();
      setData(json);
      setError(null);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStatus();
  }, []);

  const handleSync = async (action: "pull" | "stash" | "discard") => {
    setActionLoading("sync");
    setConsoleMsg(null);
    try {
      const res = await fetch("/api/control-plane/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action })
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to sync");
      setConsoleMsg("Workspace synced successfully.");
      await fetchStatus();
    } catch (err: any) {
      setConsoleMsg(`Error: ${err.message}`);
    } finally {
      setActionLoading(null);
    }
  };

  const handlePrepare = async () => {
    setActionLoading("prepare");
    setPlan(null);
    setConsoleMsg(null);
    try {
      const res = await fetch("/api/control-plane/prepare", { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to prepare deploy");
      setPlan(json);
      setConsoleMsg("Deployment plan generated. Review details below.");
    } catch (err: any) {
      setConsoleMsg(`Error: ${err.message}`);
    } finally {
      setActionLoading(null);
    }
  };

  const handleDeploy = async () => {
    if (!plan) return;
    if (approvalInput !== plan.approvalPhrase) {
      setConsoleMsg(`Error: Please type "${plan.approvalPhrase}" exactly to authorize deployment.`);
      return;
    }

    setActionLoading("deploy");
    setConsoleMsg("Starting deployment. Applying Spanner DDL, provisioning Pub/Sub, restarting GKE... (this may take up to 2 minutes)");
    try {
      const res = await fetch("/api/control-plane/deploy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planId: plan.planId, approval: approvalInput })
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Deployment failed");
      setConsoleMsg("Deployment completed successfully! Running canary check...");
      
      // Automatically trigger canary verification
      const canaryRes = await fetch("/api/control-plane/canary", { method: "POST" });
      const canaryJson = await canaryRes.json();
      if (canaryJson.passed) {
        setConsoleMsg("Deployment completed and Canary verification PASSED! System is fully live.");
      } else {
        setConsoleMsg("Deployment completed, but Canary verification TIMED OUT. Please check logs.");
      }

      setPlan(null);
      setApprovalInput("");
      await fetchStatus();
    } catch (err: any) {
      setConsoleMsg(`Error: ${err.message}`);
    } finally {
      setActionLoading(null);
    }
  };

  const handleCanary = async () => {
    setActionLoading("canary");
    setConsoleMsg("Publishing canary message and polling Spanner ledger...");
    try {
      const res = await fetch("/api/control-plane/canary", { method: "POST" });
      const json = await res.json();
      if (json.passed) {
        setConsoleMsg("Canary verification PASSED! End-to-end Pub/Sub to Spanner pipeline is healthy.");
      } else {
        setConsoleMsg("Canary verification FAILED. Message not processed within timeout.");
      }
    } catch (err: any) {
      setConsoleMsg(`Error: ${err.message}`);
    } finally {
      setActionLoading(null);
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "READY":
      case "HEALTHY":
      case "v1.2.0":
        return <span className="t-badge t-badge-green">READY</span>;
      case "SYNC_NEEDED":
        return <span className="t-badge t-badge-cyan">SYNC NEEDED</span>;
      case "DIRTY":
        return <span className="t-badge t-badge-rose">DIRTY</span>;
      case "WRONG_BRANCH":
        return <span className="t-badge t-badge-rose">WRONG BRANCH</span>;
      case "LIVE_MISMATCH":
        return <span className="t-badge t-badge-rose">LIVE MISMATCH</span>;
      default:
        return <span className="t-badge t-badge-rose">{status}</span>;
    }
  };

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--t1)] font-sans">
      {/* Header */}
      <header className="border-b border-[var(--b1)] bg-black/40 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-[1400px] mx-auto px-6 h-14 flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <Shield className="w-5 h-5 text-[var(--nc)]" />
            <span className="font-serif text-lg font-medium tracking-tight">Truth Control Plane</span>
          </div>
          <div className="flex items-center space-x-4">
            <Link to="/chat" className="text-xs text-[var(--t2)] hover:text-[var(--t1)] transition-colors">
              Back to Chat
            </Link>
            <button 
              onClick={fetchStatus} 
              disabled={loading || actionLoading !== null}
              className="t-btn t-btn-ghost py-1 px-3 flex items-center gap-1 text-xs"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-[1400px] mx-auto px-6 py-8">
        {error && (
          <div className="mb-6 p-4 bg-rose-500/10 border border-rose-500/20 rounded-xl flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-rose-500 shrink-0 mt-0.5" />
            <div>
              <h4 className="font-semibold text-rose-500 text-sm">Control Plane Error</h4>
              <p className="text-xs text-[var(--t2)] mt-1">{error}</p>
            </div>
          </div>
        )}

        {/* Top Aggregated Status */}
        {data && (
          <div className="mb-8 p-6 bg-white/3 border border-[var(--b1)] rounded-2xl flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div className="flex items-center gap-4">
              <div className={`w-10 h-10 rounded-full flex items-center justify-center ${
                data.status === "READY" ? "bg-emerald-500/10 text-emerald-400" : "bg-amber-500/10 text-amber-400"
              }`}>
                {data.status === "READY" ? <CheckCircle2 className="w-6 h-6" /> : <AlertTriangle className="w-6 h-6" />}
              </div>
              <div>
                <h2 className="text-lg font-bold flex items-center gap-2">
                  System Status: {getStatusBadge(data.status)}
                </h2>
                <p className="text-xs text-[var(--t2)] mt-1">
                  {data.status === "READY" 
                    ? "All services, schemas, and workspace branches are fully aligned and healthy." 
                    : "Action required to align the workspace or deploy the canonical version."}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              {data.status === "SYNC_NEEDED" && (
                <button 
                  onClick={() => handleSync("pull")} 
                  className="t-btn t-btn-primary text-xs font-semibold"
                  disabled={actionLoading !== null}
                >
                  Sync Workspace
                </button>
              )}
              {data.status === "READY" && data.live.status === "LIVE_MISMATCH" && (
                <button 
                  onClick={handlePrepare} 
                  className="t-btn t-btn-primary text-xs font-semibold"
                  disabled={actionLoading !== null}
                >
                  Prepare Deploy
                </button>
              )}
            </div>
          </div>
        )}

        {/* 3-Column Grid */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
          {/* 1. Workspace */}
          <div className="t-card p-6 flex flex-col justify-between min-h-[260px]">
            <div>
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-semibold text-[var(--t2)] flex items-center gap-2">
                  <GitBranch className="w-4 h-4 text-[var(--nc)]" />
                  1. Workspace
                </h3>
                {data && getStatusBadge(data.workspace.status)}
              </div>
              {data ? (
                <div className="space-y-3 text-xs">
                  <div className="flex justify-between">
                    <span className="text-[var(--t3)]">Branch:</span>
                    <span className="font-mono text-[var(--t1)]">{data.workspace.branch}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[var(--t3)]">Local SHA:</span>
                    <span className="font-mono text-[var(--t1)]">{data.workspace.localSha}</span>
                  </div>
                  {data.workspace.status === "SYNC_NEEDED" && (
                    <div className="flex justify-between">
                      <span className="text-[var(--t3)]">Remote SHA:</span>
                      <span className="font-mono text-[var(--t1)]">{data.workspace.remoteSha}</span>
                    </div>
                  )}
                  <div className="flex justify-between">
                    <span className="text-[var(--t3)]">Dirty Changes:</span>
                    <span className="text-[var(--t1)]">{data.workspace.isDirty ? "Yes ⚠️" : "No"}</span>
                  </div>
                  {data.workspace.message && (
                    <p className="p-2.5 bg-white/2 border border-[var(--b1)] rounded-lg text-[var(--t2)] leading-relaxed mt-2 text-[11px]">
                      {data.workspace.message}
                    </p>
                  )}
                </div>
              ) : (
                <div className="h-24 t-skeleton" />
              )}
            </div>

            {data && data.workspace.isDirty && (
              <div className="flex gap-2 mt-4">
                <button 
                  onClick={() => handleSync("stash")} 
                  className="t-btn t-btn-ghost flex-1 justify-center text-xs py-1.5"
                  disabled={actionLoading !== null}
                >
                  Stash
                </button>
                <button 
                  onClick={() => handleSync("discard")} 
                  className="t-btn t-btn-ghost flex-1 justify-center text-xs py-1.5 text-rose-400 hover:text-rose-300"
                  disabled={actionLoading !== null}
                >
                  Discard
                </button>
              </div>
            )}
          </div>

          {/* 2. Live Deployment */}
          <div className="t-card p-6 flex flex-col justify-between min-h-[260px]">
            <div>
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-semibold text-[var(--t2)] flex items-center gap-2">
                  <Layers className="w-4 h-4 text-[var(--nc)]" />
                  2. Live Deployment
                </h3>
                {data && getStatusBadge(data.live.status)}
              </div>
              {data ? (
                <div className="space-y-3 text-xs">
                  <div className="flex justify-between">
                    <span className="text-[var(--t3)]">Environment:</span>
                    <span className="text-[var(--t1)] font-medium capitalize">{data.live.environment}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[var(--t3)]">Deployed SHA:</span>
                    <span className="font-mono text-[var(--t1)]">{data.live.liveSha}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[var(--t3)]">Target SHA:</span>
                    <span className="font-mono text-[var(--t1)]">{data.live.localSha}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[var(--t3)]">Route Health:</span>
                    <span className={`font-medium ${data.live.routeHealth === 'passing' ? 'text-emerald-400' : 'text-rose-400'}`}>
                      {data.live.routeHealth.toUpperCase()}
                    </span>
                  </div>
                </div>
              ) : (
                <div className="h-24 t-skeleton" />
              )}
            </div>

            {data && data.live.status === "LIVE_MISMATCH" && (
              <button 
                onClick={handlePrepare} 
                className="t-btn t-btn-primary w-full justify-center text-xs py-1.5 mt-4"
                disabled={actionLoading !== null}
              >
                Prepare Deploy
              </button>
            )}
          </div>

          {/* 3. Infrastructure */}
          <div className="t-card p-6 flex flex-col justify-between min-h-[260px]">
            <div>
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-semibold text-[var(--t2)] flex items-center gap-2">
                  <HardDrive className="w-4 h-4 text-[var(--nc)]" />
                  3. Infrastructure
                </h3>
                {data && getStatusBadge(data.infra.spannerSchema)}
              </div>
              {data ? (
                <div className="space-y-3 text-xs">
                  <div className="flex justify-between">
                    <span className="text-[var(--t3)]">Spanner DB:</span>
                    <span className="font-mono text-[var(--t1)]">{data.infra.spannerSchema}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[var(--t3)]">Pub/Sub:</span>
                    <span className="font-mono text-[var(--t1)]">{data.infra.pubsubVersion}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[var(--t3)]">Workers:</span>
                    <span className={`font-medium ${data.infra.workersHealthy ? 'text-emerald-400' : 'text-rose-400'}`}>
                      {data.infra.workersHealthy ? "9/9 HEALTHY" : "INCOMPLETE"}
                    </span>
                  </div>
                  {data.infra.details.missingTables.length > 0 && (
                    <div className="text-[11px] text-amber-400/80 bg-amber-500/5 p-2 rounded border border-amber-500/10 mt-1">
                      Missing Tables: {data.infra.details.missingTables.join(", ")}
                    </div>
                  )}
                </div>
              ) : (
                <div className="h-24 t-skeleton" />
              )}
            </div>

            {data && (
              <button 
                onClick={handleCanary} 
                className="t-btn t-btn-ghost w-full justify-center text-xs py-1.5 mt-4 flex items-center gap-1"
                disabled={actionLoading !== null}
              >
                <Zap className="w-3.5 h-3.5" />
                Run Canary Test
              </button>
            )}
          </div>
        </div>

        {/* Action Console & Approval Panel */}
        {(plan || consoleMsg) && (
          <div className="t-card p-6 border-dashed border-[var(--b1)] bg-black/20">
            <h3 className="text-sm font-semibold text-[var(--t2)] mb-4 flex items-center gap-2">
              <Terminal className="w-4 h-4 text-[var(--nc)]" />
              Action Console
            </h3>

            {consoleMsg && (
              <pre className="p-4 bg-[var(--s2)] border border-[var(--b1)] rounded-xl font-mono text-xs text-[var(--t2)] leading-relaxed overflow-x-auto max-h-48 mb-4">
                {consoleMsg}
              </pre>
            )}

            {plan && (
              <div className="p-5 bg-amber-500/5 border border-amber-500/10 rounded-xl mb-4">
                <h4 className="text-xs font-bold uppercase tracking-wider text-amber-400 mb-3">
                  Deployment Plan Required ({plan.action.toUpperCase()})
                </h4>
                <div className="space-y-2 mb-4">
                  {plan.changes.map((c, idx) => (
                    <div key={idx} className="flex items-center gap-2 text-xs">
                      <ChevronRight className="w-3 h-3 text-amber-400" />
                      <span className="font-mono text-amber-400/80">[{c.type}]</span>
                      <span className="text-[var(--t1)]">{c.name}</span>
                    </div>
                  ))}
                  {plan.changes.length === 0 && (
                    <div className="text-xs text-[var(--t2)]">
                      No infrastructure changes. Application code rollout only.
                    </div>
                  )}
                </div>

                <div className="flex flex-col md:flex-row md:items-center gap-4 border-t border-amber-500/10 pt-4">
                  <div className="flex-1">
                    <p className="text-xs text-[var(--t2)] leading-relaxed">
                      This action will deploy commit <span className="font-mono text-[var(--t1)]">{data?.workspace.localSha}</span> to staging. 
                      To authorize, type <span className="font-mono text-amber-400 font-bold bg-white/5 px-1.5 py-0.5 rounded">DEPLOY V1.2</span> in the box.
                    </p>
                  </div>
                  <div className="flex gap-2 shrink-0">
                    <input 
                      type="text"
                      value={approvalInput}
                      onChange={(e) => setApprovalInput(e.target.value)}
                      placeholder="Type DEPLOY V1.2"
                      className="bg-black border border-[var(--b1)] rounded-lg px-3 py-1.5 text-xs font-mono text-[var(--t1)] focus:outline-none focus:border-[var(--nc)] w-48"
                    />
                    <button 
                      onClick={handleDeploy}
                      disabled={actionLoading === "deploy" || approvalInput !== plan.approvalPhrase}
                      className="t-btn t-btn-primary text-xs py-1.5 px-4 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {actionLoading === "deploy" ? "Deploying..." : "Approve & Deploy"}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
