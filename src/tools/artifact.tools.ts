import { z } from "zod";
import { RegisteredTool, ToolContext } from "./types";
import { callGcpMcpTool } from "./gcp-mcp-client";
import { env } from "../config/env";
import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";

// ============================================================================
// HTML5 Artifact Tools — Template-Driven, Live Data, Design System
// ============================================================================

const ARTIFACT_BUCKET = "clearspace-artifacts";
const ARTIFACT_PREFIX = "truth-artifacts";
const TEMPLATE_PREFIX = "truth-templates";
const STORAGE_MCP = "https://storage.googleapis.com/storage/mcp";
const CLOUDRUN_MCP = "https://run.googleapis.com/mcp";

// ---------------------------------------------------------------------------
// Template Registry — keyword → template file mapping
// ---------------------------------------------------------------------------
interface TemplateEntry {
  id: string;
  keywords: string[];
  description: string;
}

const TEMPLATE_REGISTRY: TemplateEntry[] = [
  {
    id: "dashboard",
    keywords: ["dashboard", "monitoring", "overview", "ops", "console", "control center", "metrics", "admin panel"],
    description: "Operations dashboard with stat cards, live terminal log, and tool registry table"
  },
  {
    id: "data-table",
    keywords: ["table", "list", "registry", "inventory", "catalog", "grid", "spreadsheet", "data view", "records"],
    description: "Searchable, sortable data table with category badges and row filtering"
  },
  {
    id: "status-page",
    keywords: ["status", "health", "uptime", "service status", "incident", "monitoring page", "health check"],
    description: "Service status page with global health indicator, service cards, metrics, and event log"
  },
  {
    id: "landing",
    keywords: ["landing", "homepage", "marketing", "product page", "hero", "launch", "announcement", "showcase"],
    description: "Landing page with hero section, live stats bar, feature cards, and CTAs"
  },
  {
    id: "api-explorer",
    keywords: ["api", "playground", "explorer", "endpoint", "tester", "tool tester", "sandbox", "repl", "try it"],
    description: "Split-pane API explorer with tool sidebar, request editor, and response viewer"
  },
  {
    id: "docs",
    keywords: ["documentation", "reference", "guide", "spec", "api docs", "manual", "handbook", "wiki"],
    description: "Documentation page with sidebar navigation, endpoint reference, and tool catalog"
  }
];

/**
 * Match user intent to a template using keyword scoring
 */
function matchTemplate(intent: string): TemplateEntry | null {
  if (!intent) return null;
  const normalized = intent.toLowerCase().trim();

  let bestMatch: TemplateEntry | null = null;
  let bestScore = 0;

  for (const template of TEMPLATE_REGISTRY) {
    let score = 0;
    for (const keyword of template.keywords) {
      if (normalized.includes(keyword)) {
        score += keyword.length; // longer keyword matches are worth more
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestMatch = template;
    }
  }

  return bestScore > 0 ? bestMatch : null;
}

/**
 * Load a template — try local filesystem first, fall back to GCS
 */
async function loadTemplate(templateId: string): Promise<string | null> {
  // 1. Try local filesystem (works during development + in Docker if templates are copied)
  const localPath = path.join(process.cwd(), "templates", `${templateId}.html`);
  try {
    if (fs.existsSync(localPath)) {
      return fs.readFileSync(localPath, "utf-8");
    }
  } catch {}

  // 2. Try dist/templates (for production builds where Vite copies public/)
  const distPath = path.join(process.cwd(), "dist", "templates", `${templateId}.html`);
  try {
    if (fs.existsSync(distPath)) {
      return fs.readFileSync(distPath, "utf-8");
    }
  } catch {}

  // 3. Fall back to GCS
  try {
    const result = await callGcpMcpTool(STORAGE_MCP, "read_text", {
      bucketName: ARTIFACT_BUCKET,
      objectName: `${TEMPLATE_PREFIX}/${templateId}.html`,
      projectId: env.GCP_PROJECT
    });
    return typeof result === "string" ? result : (result?.content || result?.text || null);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// SEO Meta Builder — auto-injected into every artifact
// ---------------------------------------------------------------------------
function buildSeoMeta(title: string, description: string, artifactId: string): string {
  const canonicalUrl = `https://reverie-70323048967.us-central1.run.app/api/artifacts/${artifactId}`;
  const safeTitle = title.replace(/"/g, '&quot;');
  const safeDesc = (description || title).replace(/"/g, '&quot;').slice(0, 160);

  return `
  <!-- SEO Meta — Auto-injected by Truth -->
  <meta name="description" content="${safeDesc}">
  <meta name="theme-color" content="#0B0F19">
  <link rel="canonical" href="${canonicalUrl}">

  <!-- Open Graph -->
  <meta property="og:type" content="website">
  <meta property="og:title" content="${safeTitle}">
  <meta property="og:description" content="${safeDesc}">
  <meta property="og:url" content="${canonicalUrl}">

  <!-- Twitter Card -->
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${safeTitle}">
  <meta name="twitter:description" content="${safeDesc}">

  <!-- Structured Data -->
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "WebPage",
    "name": "${safeTitle}",
    "description": "${safeDesc}",
    "url": "${canonicalUrl}",
    "publisher": { "@type": "Organization", "name": "Truth" }
  }
  </script>`;
}

// ---------------------------------------------------------------------------
// TRUTH DESIGN SYSTEM CSS — auto-injected into every artifact
// ---------------------------------------------------------------------------
const TRUTH_DESIGN_SYSTEM = `
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500;700&display=swap');
  :root {
    --t-bg-primary:#0B0F19;--t-bg-secondary:#131825;--t-bg-card:#161F30;--t-bg-elevated:#1A2332;--t-bg-input:#0D1117;
    --t-border:rgba(255,255,255,0.08);--t-border-hover:rgba(255,255,255,0.15);
    --t-text-primary:#F1F5F9;--t-text-secondary:#94A3B8;--t-text-muted:#64748B;--t-text-accent:#06B6D4;
    --t-cyan:#06B6D4;--t-purple:#A855F7;--t-blue:#3B82F6;--t-emerald:#10B981;--t-amber:#F59E0B;--t-rose:#F43F5E;
    --t-gradient-brand:linear-gradient(135deg,#06B6D4,#A855F7);
    --t-gradient-subtle:linear-gradient(135deg,rgba(6,182,212,0.1),rgba(168,85,247,0.1));
    --t-gradient-card:linear-gradient(145deg,#161F30,#131825);
    --t-glass-bg:rgba(22,31,48,0.7);--t-glass-border:rgba(255,255,255,0.06);--t-glass-blur:20px;
    --t-space-xs:4px;--t-space-sm:8px;--t-space-md:16px;--t-space-lg:24px;--t-space-xl:32px;--t-space-2xl:48px;
    --t-radius-sm:6px;--t-radius-md:10px;--t-radius-lg:16px;--t-radius-xl:20px;
    --t-shadow-sm:0 1px 3px rgba(0,0,0,0.3);--t-shadow-md:0 4px 12px rgba(0,0,0,0.4);--t-shadow-lg:0 8px 32px rgba(0,0,0,0.5);
    --t-font:'Inter',-apple-system,sans-serif;--t-mono:'JetBrains Mono','Fira Code',monospace;
  }
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:var(--t-font);background:var(--t-bg-primary);color:var(--t-text-primary);line-height:1.6;min-height:100vh;-webkit-font-smoothing:antialiased}
  .t-page{max-width:1280px;margin:0 auto;padding:var(--t-space-xl)}.t-page-full{width:100%;padding:var(--t-space-xl)}
  .t-grid{display:grid;gap:var(--t-space-lg)}.t-grid-2{grid-template-columns:repeat(2,1fr)}.t-grid-3{grid-template-columns:repeat(3,1fr)}.t-grid-4{grid-template-columns:repeat(4,1fr)}
  .t-flex{display:flex;gap:var(--t-space-md)}.t-flex-col{flex-direction:column}.t-flex-between{justify-content:space-between;align-items:center}.t-flex-center{justify-content:center;align-items:center}
  .t-card{background:var(--t-gradient-card);border:1px solid var(--t-border);border-radius:var(--t-radius-lg);padding:var(--t-space-lg);transition:all .2s}.t-card:hover{border-color:var(--t-border-hover);box-shadow:var(--t-shadow-md)}
  .t-card-glass{background:var(--t-glass-bg);backdrop-filter:blur(var(--t-glass-blur));-webkit-backdrop-filter:blur(var(--t-glass-blur));border:1px solid var(--t-glass-border);border-radius:var(--t-radius-lg);padding:var(--t-space-lg)}
  .t-card-accent{background:var(--t-gradient-subtle);border:1px solid rgba(6,182,212,0.2);border-radius:var(--t-radius-lg);padding:var(--t-space-lg)}
  .t-h1{font-size:28px;font-weight:800;letter-spacing:-.5px;line-height:1.2}.t-h2{font-size:20px;font-weight:700;letter-spacing:-.3px}.t-h3{font-size:15px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:var(--t-text-secondary)}
  .t-body{font-size:14px;color:var(--t-text-secondary)}.t-mono{font-family:var(--t-mono);font-size:13px}.t-label{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:1px;color:var(--t-text-muted)}.t-accent{color:var(--t-text-accent)}
  .t-badge{display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:600;padding:4px 10px;border-radius:100px;letter-spacing:.3px}
  .t-badge-green{background:rgba(16,185,129,0.12);color:#34D399;border:1px solid rgba(16,185,129,0.2)}.t-badge-cyan{background:rgba(6,182,212,0.12);color:#22D3EE;border:1px solid rgba(6,182,212,0.2)}
  .t-badge-purple{background:rgba(168,85,247,0.12);color:#C084FC;border:1px solid rgba(168,85,247,0.2)}.t-badge-amber{background:rgba(245,158,11,0.12);color:#FBBF24;border:1px solid rgba(245,158,11,0.2)}
  .t-badge-rose{background:rgba(244,63,94,0.12);color:#FB7185;border:1px solid rgba(244,63,94,0.2)}
  .t-stat{text-align:center}.t-stat-value{font-size:32px;font-weight:800;background:var(--t-gradient-brand);-webkit-background-clip:text;-webkit-text-fill-color:transparent}.t-stat-label{font-size:12px;color:var(--t-text-muted);margin-top:4px}
  .t-table{width:100%;border-collapse:separate;border-spacing:0;font-size:13px}.t-table thead th{padding:10px 16px;text-align:left;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:var(--t-text-muted);border-bottom:1px solid var(--t-border);background:var(--t-bg-secondary)}
  .t-table tbody td{padding:10px 16px;border-bottom:1px solid var(--t-border);color:var(--t-text-secondary)}.t-table tbody tr:hover td{background:rgba(255,255,255,0.02);color:var(--t-text-primary)}
  .t-btn{display:inline-flex;align-items:center;gap:8px;padding:10px 20px;font-size:13px;font-weight:600;border:none;border-radius:var(--t-radius-md);cursor:pointer;transition:all .15s;font-family:var(--t-font)}
  .t-btn-primary{background:var(--t-blue);color:white;box-shadow:0 2px 8px rgba(59,130,246,0.3)}.t-btn-primary:hover{background:#2563EB;transform:translateY(-1px)}
  .t-btn-ghost{background:transparent;color:var(--t-text-secondary);border:1px solid var(--t-border)}.t-btn-ghost:hover{border-color:var(--t-border-hover);color:var(--t-text-primary)}
  .t-input{width:100%;padding:10px 14px;font-size:13px;background:var(--t-bg-input);color:var(--t-text-primary);border:1px solid var(--t-border);border-radius:var(--t-radius-md);font-family:var(--t-mono);outline:none;transition:border-color .15s}
  .t-input:focus{border-color:var(--t-cyan);box-shadow:0 0 0 2px rgba(6,182,212,0.1)}
  .t-terminal{background:#0A0E14;border:1px solid var(--t-border);border-radius:var(--t-radius-lg);overflow:hidden;font-family:var(--t-mono);font-size:12px}
  .t-terminal-header{background:var(--t-bg-secondary);border-bottom:1px solid var(--t-border);padding:10px 16px;display:flex;align-items:center;justify-content:space-between}
  .t-terminal-dots{display:flex;gap:6px}.t-terminal-dots span{width:10px;height:10px;border-radius:50%}
  .t-terminal-body{padding:16px;max-height:400px;overflow-y:auto;line-height:1.8}
  .t-pulse{width:8px;height:8px;border-radius:50%;background:var(--t-emerald);box-shadow:0 0 6px var(--t-emerald);animation:t-pulse-anim 2s infinite}
  @keyframes t-pulse-anim{0%,100%{opacity:1}50%{opacity:.4}}
  .t-skeleton{background:linear-gradient(90deg,var(--t-bg-card) 25%,var(--t-bg-elevated) 50%,var(--t-bg-card) 75%);background-size:200% 100%;animation:t-shimmer 1.5s infinite;border-radius:var(--t-radius-sm)}
  @keyframes t-shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
  @media(max-width:768px){.t-grid-2,.t-grid-3,.t-grid-4{grid-template-columns:1fr}.t-page{padding:var(--t-space-md)}}
  ::-webkit-scrollbar{width:6px}::-webkit-scrollbar-track{background:var(--t-bg-primary)}::-webkit-scrollbar-thumb{background:var(--t-bg-elevated);border-radius:3px}
</style>`;

// ---------------------------------------------------------------------------
// Tool description with template + data API reference
// ---------------------------------------------------------------------------
const CREATE_ARTIFACT_DESCRIPTION = `Create a production-quality HTML5 mini web app. NOT a mockup — must pull LIVE data and look premium.

CRITICAL RULES:
1. ALWAYS fetch() live data from Truth API (same-origin):
   - GET /api/system/status → { status, uptime, uptimeFormatted, memory:{heapUsedMB,heapTotalMB,rssMB}, tools:{count,names}, node, env, region, timestamp }
   - GET /api/debug/tools → { count, tools:[{name,description}] }
   - GET /api/artifacts → list of saved artifacts
   - GET /healthz → { status:"ok" }
2. NEVER hardcode mock data. Use fetch() with skeleton loaders (.t-skeleton class), then populate.
3. Truth Design System CSS is auto-injected. Use these classes:
   LAYOUT: .t-page .t-grid .t-grid-2/3/4 .t-flex .t-flex-between
   CARDS: .t-card .t-card-glass .t-card-accent
   TYPE: .t-h1 .t-h2 .t-h3 .t-body .t-mono .t-label .t-accent
   BADGES: .t-badge + .t-badge-green/cyan/purple/amber/rose
   STATS: .t-stat .t-stat-value .t-stat-label
   TABLE: .t-table
   BUTTONS: .t-btn .t-btn-primary .t-btn-ghost
   TERMINAL: .t-terminal .t-terminal-header .t-terminal-body
   LOADING: .t-skeleton (shimmer animation)
   LIVE DOT: .t-pulse
4. Auto-refresh data every 10-30s with setInterval.
5. Return COMPLETE HTML with <!DOCTYPE html>.

AVAILABLE TEMPLATES (use "intent" param to auto-select):
- dashboard: ops dashboard with stat cards + terminal + tool list
- data-table: searchable sortable data table
- status-page: service health with global indicator
- landing: hero + features + stats bar
- api-explorer: split-pane tool tester
- docs: sidebar navigation + endpoint reference

If intent is provided, the matching template is loaded and included in the response as "baseTemplate". Use it as your starting point and customize the <!-- CUSTOMIZE --> sections.`;

// ============================================================================
// Tool definitions
// ============================================================================

export const artifactTools: RegisteredTool<any>[] = [
  {
    definition: {
      name: "create_html_artifact",
      description: CREATE_ARTIFACT_DESCRIPTION,
      schema: z.object({
        title: z.string().min(1, "Title is required"),
        html: z.string().min(10, "HTML content is required"),
        intent: z.string().optional().describe("User intent to match a template: dashboard, table, status, landing, api, docs"),
        description: z.string().optional()
      })
    },
    handler: async (args) => {
      const artifactId = randomUUID().split("-")[0];
      const objectName = `${ARTIFACT_PREFIX}/${artifactId}.html`;
      const timestamp = new Date().toISOString();

      // Template matching
      let templateMatch: TemplateEntry | null = null;
      let templateHtml: string | null = null;

      if (args.intent) {
        templateMatch = matchTemplate(args.intent);
        if (templateMatch) {
          templateHtml = await loadTemplate(templateMatch.id);
        }
      }

      // Auto-inject Design System + SEO meta tags
      let finalHtml = args.html;
      const seoBlock = buildSeoMeta(args.title, args.description || args.title, artifactId);

      if (finalHtml.includes('<head>')) {
        finalHtml = finalHtml.replace('<head>', `<head>\n${seoBlock}\n${TRUTH_DESIGN_SYSTEM}`);
      } else if (finalHtml.includes('</head>')) {
        finalHtml = finalHtml.replace('</head>', `${seoBlock}\n${TRUTH_DESIGN_SYSTEM}\n</head>`);
      } else {
        finalHtml = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${args.title}</title>${seoBlock}\n${TRUTH_DESIGN_SYSTEM}</head><body>${finalHtml}</body></html>`;
      }

      // Save to Cloud Storage
      try {
        await callGcpMcpTool(STORAGE_MCP, "write_text", {
          bucketName: ARTIFACT_BUCKET,
          objectName,
          textContent: finalHtml,
          projectId: env.GCP_PROJECT
        });
      } catch (err: any) {
        return {
          error: `Failed to save artifact to Cloud Storage: ${err.message}`,
          artifactId,
          fallback: "The HTML was generated but could not be persisted."
        };
      }

      // Build data URI for inline preview
      const base64 = Buffer.from(finalHtml, "utf-8").toString("base64");
      const dataUri = `data:text/html;base64,${base64}`;

      const response: any = {
        artifactId,
        title: args.title,
        description: args.description || "",
        storageUrl: `gs://${ARTIFACT_BUCKET}/${objectName}`,
        previewUrl: `/api/artifacts/${artifactId}`,
        dataUri,
        timestamp,
        message: `HTML artifact "${args.title}" created and saved.`
      };

      // Include matched template for the LLM to reference
      if (templateMatch && templateHtml) {
        response.templateUsed = templateMatch.id;
        response.templateDescription = templateMatch.description;
        response.baseTemplate = templateHtml;
      }

      return response;
    }
  },
  {
    definition: {
      name: "deploy_html_artifact",
      description: "Deploy a previously created HTML artifact to Cloud Run as a live public website. Returns the public URL.",
      schema: z.object({
        artifactId: z.string().min(1, "Artifact ID is required"),
        serviceName: z.string().optional()
      })
    },
    handler: async (args) => {
      const objectName = `${ARTIFACT_PREFIX}/${args.artifactId}.html`;
      const serviceName = args.serviceName || `truth-page-${args.artifactId}`;

      let htmlContent: string;
      try {
        const result = await callGcpMcpTool(STORAGE_MCP, "read_text", {
          bucketName: ARTIFACT_BUCKET,
          objectName,
          projectId: env.GCP_PROJECT
        });
        htmlContent = typeof result === "string" ? result : (result?.content || result?.text || JSON.stringify(result));
      } catch (err: any) {
        return { error: `Failed to read artifact from Cloud Storage: ${err.message}` };
      }

      try {
        const deployResult = await callGcpMcpTool(CLOUDRUN_MCP, "deploy_service_from_file_contents", {
          service: {
            name: serviceName,
            project: env.GCP_PROJECT,
            region: "us-central1",
            template: {
              containers: [{
                image: "node:22-slim",
                command: ["node", "server.js"],
                ports: [{ containerPort: 8080 }]
              }]
            },
            invokerIamDisabled: true,
            sourceCode: {
              sources: [
                { filename: "index.html", content: htmlContent },
                {
                  filename: "server.js",
                  content: `const http=require('http');const fs=require('fs');const html=fs.readFileSync('index.html','utf8');http.createServer((_,r)=>{r.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});r.end(html)}).listen(process.env.PORT||8080);`
                },
                {
                  filename: "Dockerfile",
                  content: `FROM node:22-slim\nWORKDIR /app\nCOPY . .\nEXPOSE 8080\nCMD ["node","server.js"]`
                }
              ]
            },
            baseImageUri: "node:22-slim"
          }
        });
        return { artifactId: args.artifactId, serviceName, deployResult, message: `Artifact deployed as "${serviceName}".` };
      } catch (err: any) {
        return { error: `Failed to deploy artifact: ${err.message}` };
      }
    }
  },
  {
    definition: {
      name: "list_html_artifacts",
      description: "List all saved HTML artifacts from Cloud Storage.",
      schema: z.object({})
    },
    handler: async () => {
      try {
        const result = await callGcpMcpTool(STORAGE_MCP, "list_objects", {
          bucketName: ARTIFACT_BUCKET,
          prefix: `${ARTIFACT_PREFIX}/`,
          projectId: env.GCP_PROJECT
        });
        return result;
      } catch (err: any) {
        return { error: `Failed to list artifacts: ${err.message}` };
      }
    }
  }
];
