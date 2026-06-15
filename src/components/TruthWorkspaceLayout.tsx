/**
 * TRUTH PLATFORM — ENTERPRISE SIDEBAR & CONTEXT CARD ENGINE
 * 
 * [Design System & Accessibility Hardening Specs]:
 * - Sidebar Active State: Muted premium background (bg-[#2D3748]), high-contrast white text, left-border accent (border-l-4 border-cyan-500).
 * - Focus States: WCAG AA compliant outlines (focus-visible:ring-2 focus-visible:ring-cyan-500/50).
 * - Factory Pattern: Translates raw API metadata arrays into structured card elements mapped by type.
 * - Raw JSON Scaped: All raw backend data payloads are completely abstracted from view.
 */

import React, { useState } from "react";
import { 
  FileText, 
  Calendar, 
  Mail, 
  Database, 
  CreditCard, 
  Trash2, 
  LayoutDashboard, 
  GitBranch, 
  Terminal, 
  Library, 
  CloudLightning, 
  ExternalLink 
} from "lucide-react";

// ============================================================================
// 1. Types & Raw API JSON Definitions
// ============================================================================
export type IntegrationType = "doc" | "calendar" | "gmail" | "spanner" | "stripe";

export interface RawMetadataItem {
  id: string;
  publisher: string;
  type: IntegrationType;
  title: string;
  updatedAt: string;
  description?: string;
}

// Simulated raw metadata array returned from Truth backend API
const initialRawMetadata: RawMetadataItem[] = [
  {
    id: "meta-1",
    publisher: "Google Workspace",
    type: "doc",
    title: "Vertex AI Gemini 3.5 & 3.1 Integration Findings",
    updatedAt: "2026-06-15",
    description: "Resolving 404 endpoint routing errors and grounding search configurations."
  },
  {
    id: "meta-2",
    publisher: "Google Calendar",
    type: "calendar",
    title: "Truth Operational Architecture Sync",
    updatedAt: "2026-06-16",
    description: "Weekly milestone review of multi-tenant storage configurations."
  },
  {
    id: "meta-3",
    publisher: "Google Cloud Platform",
    type: "spanner",
    title: "Cloud Spanner core-db (Instance: clearspace)",
    updatedAt: "2026-06-15",
    description: "Active system schema definition housing 5 platform databases."
  },
  {
    id: "meta-4",
    publisher: "Stripe Platform",
    type: "stripe",
    title: "Pro-Tier Monthly Subscription Plan Config",
    updatedAt: "2026-06-14",
    description: "Configured API endpoint tracking at 5001/api/mcp/stripe."
  },
  {
    id: "meta-5",
    publisher: "Gmail Services",
    type: "gmail",
    title: "Alert: [Kfarkye/Final] Possible valid secrets detected",
    updatedAt: "2026-06-15",
    description: "Automatic security scanner detected exposed development environment values."
  }
];

// ============================================================================
// 2. Factory Pattern Implementation
// ============================================================================

/**
 * Factory class mapping raw JSON metadata structures into highly polished, 
 * secure React card components with matching iconography and styling accents.
 */
class ContextCardFactory {
  /**
   * Generates matching typography, backgrounds and custom SVGs per metadata type.
   */
  public static createCard(
    item: RawMetadataItem, 
    onRemove: (id: string) => void
  ): React.ReactElement {
    
    // Icon & Color Mappings
    let IconComponent = FileText;
    let iconColorClass = "text-cyan-400 bg-cyan-500/10 border-cyan-500/20";
    let accentBadgeText = "Document";

    switch (item.type) {
      case "doc":
        IconComponent = FileText;
        iconColorClass = "text-cyan-400 bg-cyan-500/10 border-cyan-500/20";
        accentBadgeText = "Doc Workspace";
        break;
      case "calendar":
        IconComponent = Calendar;
        iconColorClass = "text-emerald-400 bg-emerald-500/10 border-emerald-500/20";
        accentBadgeText = "Calendar Invite";
        break;
      case "gmail":
        IconComponent = Mail;
        iconColorClass = "text-rose-400 bg-rose-500/10 border-rose-500/20";
        accentBadgeText = "Secure Email Alert";
        break;
      case "spanner":
        IconComponent = Database;
        iconColorClass = "text-amber-400 bg-amber-500/10 border-amber-500/20";
        accentBadgeText = "Spanner Schema";
        break;
      case "stripe":
        IconComponent = CreditCard;
        iconColorClass = "text-purple-400 bg-purple-500/10 border-purple-500/20";
        accentBadgeText = "Stripe Config";
        break;
    }

    return (
      <div 
        key={item.id}
        className="
          group relative flex items-start justify-between p-5 
          bg-slate-900/60 hover:bg-slate-900 border border-slate-800/80 
          hover:border-slate-700/60 rounded-xl shadow-xl 
          transition-all duration-200 focus-within:ring-2 
          focus-within:ring-cyan-500/30 overflow-hidden
        "
      >
        {/* Sleek subtle top border matching the type colors */}
        <div className={`absolute top-0 left-0 right-0 h-[2px] opacity-40 group-hover:opacity-100 transition-opacity ${
          item.type === 'doc' ? 'bg-cyan-500' :
          item.type === 'calendar' ? 'bg-emerald-500' :
          item.type === 'gmail' ? 'bg-rose-500' :
          item.type === 'spanner' ? 'bg-amber-500' : 'bg-purple-500'
        }`} />

        <div className="flex items-start space-x-4">
          {/* Dynamically Created Icon Plate */}
          <div className={`w-10 h-10 rounded-lg flex items-center justify-center border ${iconColorClass} shrink-0`}>
            <IconComponent className="w-5 h-5" />
          </div>

          <div className="space-y-1">
            <div className="flex items-center space-x-2">
              <span className="text-[10px] font-mono text-slate-500 tracking-wider font-semibold uppercase">
                {item.publisher}
              </span>
              <span className="text-[10px] text-slate-600">•</span>
              <span className="text-[10px] bg-slate-800/60 text-slate-400 px-2 py-0.5 rounded-full font-medium font-sans">
                {accentBadgeText}
              </span>
            </div>

            {/* Clean title (max prose constraints) */}
            <h4 className="text-sm font-bold text-white tracking-tight group-hover:text-cyan-400 transition-colors">
              {item.title}
            </h4>

            {item.description && (
              <p className="text-xs text-slate-400 leading-relaxed max-w-prose">
                {item.description}
              </p>
            )}

            <div className="pt-2 text-[10px] text-slate-500 font-mono">
              Last synced: {item.updatedAt}
            </div>
          </div>
        </div>

        {/* Action Button Area */}
        <div className="flex items-center space-x-1 ml-4 shrink-0">
          <button 
            onClick={() => onRemove(item.id)}
            className="
              p-2 rounded-lg bg-slate-950 hover:bg-rose-950/40 
              text-slate-500 hover:text-rose-400 border border-slate-800/80 
              hover:border-rose-900/40 transition-all duration-150 
              focus:outline-none focus:ring-2 focus:ring-rose-500/50
            "
            title={`De-register integration context`}
            aria-label={`Remove integration ${item.title}`}
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>
    );
  }
}

// ============================================================================
// 3. Main Dashboard Layout Component
// ============================================================================

interface TruthWorkspaceLayoutProps {
  onInsertContext?: (text: string) => void;
  onClose?: () => void;
}

export const TruthWorkspaceLayout: React.FC<TruthWorkspaceLayoutProps> = ({ onInsertContext, onClose }) => {
  const [activeTab, setActiveTab] = useState("overview");
  const [metadataItems, setMetadataItems] = useState<RawMetadataItem[]>(initialRawMetadata);

  // Nav configuration arrays
  const sidebarItems = [
    { id: "overview", label: "Overview", icon: LayoutDashboard },
    { id: "git", label: "Git Virtualizer", icon: GitBranch },
    { id: "notebook", label: "Deno Execution", icon: Terminal },
    { id: "discovery", label: "URN Discovery", icon: Library },
    { id: "deployment", label: "Serverless Sync", icon: CloudLightning }
  ];

  // Callback to strip items from UI mapping safely
  const handleRemoveMetadata = (id: string) => {
    setMetadataItems((prev) => prev.filter((item) => item.id !== id));
  };

  return (
    <div className="flex h-full bg-[#0B0F19] text-slate-100 overflow-hidden font-sans select-none">
      
      {/* SIDEBAR NAVIGATION PANEL */}
      <aside className="w-48 bg-[#161F30] border-r border-slate-800 flex flex-col justify-between py-4 shrink-0">
        <div className="space-y-4">
          
          {/* Platform Identity */}
          <div className="px-4 flex items-center space-x-2.5">
            <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-cyan-400 to-purple-500 flex items-center justify-center shadow-lg shadow-cyan-500/10">
              <span className="text-white font-black text-xs">T</span>
            </div>
            <div>
              <span className="text-[10px] font-black tracking-widest text-slate-200 block uppercase">Truth</span>
              <span className="text-[8px] text-slate-500 block font-mono">Orchestrator</span>
            </div>
          </div>

          <div className="px-2">
            <span className="text-[9px] font-bold text-slate-500 uppercase tracking-wider px-2 block mb-1.5">
              Navigation
            </span>
            <nav className="space-y-0.5" aria-label="Sidebar Navigation">
              {sidebarItems.map((item) => {
                const IconComponent = item.icon;
                const isActive = activeTab === item.id;
                
                return (
                  <button
                    key={item.id}
                    onClick={() => setActiveTab(item.id)}
                    className={`
                      w-full flex items-center space-x-2.5 px-2.5 py-2 rounded-lg text-xs transition-all duration-150 font-semibold outline-none group cursor-pointer
                      ${isActive 
                        ? "bg-[#2D3748] text-white border-l-4 border-cyan-500" 
                        : "text-slate-400 hover:text-slate-200 hover:bg-slate-800/40"
                      }
                      focus-visible:ring-2 focus-visible:ring-cyan-500/50 focus-visible:ring-offset-2 focus-visible:ring-offset-[#161F30]
                    `}
                    aria-current={isActive ? "page" : undefined}
                  >
                    <IconComponent className={`w-3.5 h-3.5 transition-transform group-hover:scale-110 duration-150 ${
                      isActive ? "text-cyan-400" : "text-slate-500 group-hover:text-slate-300"
                    }`} />
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </nav>
          </div>

        </div>

        {/* Footer info */}
        <div className="px-4 border-t border-slate-800 pt-3 text-xs">
          <div className="flex items-center space-x-2 text-slate-500 font-mono text-[9px]">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
            <span>Gateway V1.5.0</span>
          </div>
        </div>
      </aside>

      {/* MAIN LAYOUT CANVAS */}
      <main className="flex-1 bg-[#0B0F19] overflow-y-auto p-5 custom-scrollbar">
        <div className="max-w-full mx-auto space-y-5">
          
          {/* Tab Content Header */}
          <div className="border-b border-slate-800 pb-3 space-y-1">
            <h2 className="text-base font-black text-white tracking-tight flex items-center gap-2">
              <span>Operational Environment</span>
              <span className="text-[9px] font-mono bg-slate-900 border border-slate-800 px-1.5 py-0.5 rounded-md text-cyan-400">
                /api/workspace/metadata
              </span>
            </h2>
            <p className="text-[11px] text-slate-400">
              Metadata factory transforming raw session structures into interactive context cards.
            </p>
          </div>

          {/* ACTIVE ROUTE: SYSTEM OVERVIEW TAB */}
          {activeTab === "overview" && (
            <div className="space-y-4">
              
              {/* Dynamic Counts Tracker bar */}
              <div className="grid grid-cols-3 gap-3 bg-slate-900/40 p-3 rounded-xl border border-slate-800/60 font-mono">
                <div>
                  <span className="text-[9px] text-slate-500 block">Active Contexts</span>
                  <span className="text-base font-bold text-white">{metadataItems.length}</span>
                </div>
                <div>
                  <span className="text-[9px] text-slate-500 block">Compliance</span>
                  <span className="text-[10px] font-bold text-emerald-400">WCAG AA</span>
                </div>
                <div>
                  <span className="text-[9px] text-slate-500 block">DB Sync</span>
                  <span className="text-[10px] font-bold text-cyan-400 flex items-center gap-1">
                    <span>Active</span>
                    <ExternalLink className="w-2.5 h-2.5" />
                  </span>
                </div>
              </div>

              {/* Dynamic Context Card Layout Container */}
              <div className="space-y-3" aria-label="Dynamic Workspace Context Cards">
                {metadataItems.length > 0 ? (
                  metadataItems.map((item) => 
                    ContextCardFactory.createCard(item, handleRemoveMetadata)
                  )
                ) : (
                  <div className="p-8 text-center bg-slate-900/20 border border-dashed border-slate-800 rounded-xl space-y-2">
                    <span className="text-xs font-semibold text-slate-400 block">All context structures de-registered.</span>
                    <p className="text-[10px] text-slate-500 max-w-xs mx-auto">
                      Use Truth MCP commands to clone workspaces or trigger Spanner sync checks to rebuild context streams.
                    </p>
                    <button 
                      onClick={() => setMetadataItems(initialRawMetadata)}
                      className="mt-3 px-2.5 py-1 bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-400 border border-cyan-500/30 text-[10px] font-bold rounded-lg transition"
                    >
                      Reset Workspace Metadata Demo
                    </button>
                  </div>
                )}
              </div>

            </div>
          )}

          {/* Fallback mock routes */}
          {activeTab !== "overview" && (
            <div className="p-8 text-center bg-slate-900/30 border border-slate-800 rounded-xl">
              <span className="text-xs font-semibold text-slate-300 block mb-1">
                Route "/{activeTab}" mounted successfully.
              </span>
              <p className="text-[10px] text-slate-500">
                This console section handles operations for workspace virtualization. Navigate back to "Overview" to see the Context Card factory outputs.
              </p>
              <button 
                onClick={() => setActiveTab("overview")}
                className="mt-3 px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-white text-[10px] font-bold rounded-lg transition"
              >
                Back to Overview
              </button>
            </div>
          )}

        </div>
      </main>

      {/* Embedded CSS Custom scrollbar definitions */}
      <style>{`
        .custom-scrollbar::-webkit-scrollbar {
          width: 5px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: #0B0F19;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: #1e293b;
          border-radius: 4px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: #334155;
        }
      `}</style>

    </div>
  );
};

export default TruthWorkspaceLayout;
