/**
 * mlb-tables.tools.ts — "MLB Tables" census tool.
 *
 * Queries INFORMATION_SCHEMA + COUNT(*) for every table in sports-mlb-db.
 * Returns BOTH structured JSON (for the AI to narrate) and a fully styled
 * HTML artifact (Crawler OS design system) uploaded to GCS for visual rendering.
 */

import { z } from 'zod';
import { RegisteredTool } from './types';
import { Spanner } from '@google-cloud/spanner';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { callGcpMcpTool } from './gcp-mcp-client';
import { randomUUID } from 'crypto';

// Reuse the shared Spanner client
const spanner = new Spanner({ projectId: env.SPANNER_PROJECT_ID });
const ARTIFACT_BUCKET = 'clearspace-artifacts';
const ARTIFACT_PREFIX = 'truth-artifacts';
const STORAGE_MCP = 'https://storage.googleapis.com/storage/mcp';

// ── Domain classification ────────────────────────────────────────────────────

function classifyDomain(tableName: string): string {
  const t = tableName.toLowerCase();
  if (t.includes('odds') || t.includes('price') || t.includes('quote') || t === 'currentodds') return 'Odds & Betting';
  if (t.includes('edge') || t.includes('pick')) return 'Edge & Picks';
  if (t.includes('pm') || t.includes('prediction')) return 'Prediction Markets';
  if (t.includes('player') || t.includes('athlete') || t.includes('pitcher') || t.includes('batting') || t.includes('pitching') || t.includes('arsenal') || t.includes('splits') || t.includes('performance') || t.includes('fantasy')) return 'Player Stats';
  if (t.includes('team') && !t.includes('abbreviation')) return 'Team Analytics';
  if (t.includes('game') || t.includes('play') || t.includes('pitch') || t.includes('boxscore') || t.includes('lineup') || t.includes('series') || t.includes('winprob')) return 'Game Data';
  if (t.includes('umpire')) return 'Umpires';
  if (t.includes('venue') || t.includes('condition') || t.includes('environment') || t.includes('weather') || t.includes('bullpen')) return 'Context';
  if (t.includes('external') || t.includes('covers') || t.includes('teamranking') || t.includes('research')) return 'External';
  if (t.includes('ingest') || t.includes('feed') || t.includes('worker') || t.includes('lease') || t.includes('quota') || t.includes('ratelimit')) return 'Infra';
  if (t.includes('crosswalk') || t.includes('alias') || t.includes('abbreviation') || t.includes('catalog') || t.includes('provider') || t.includes('map') || t.includes('entity')) return 'Identity';
  if (t.includes('antigravity') || t.includes('audit') || t.includes('artifact') || t.includes('codebase') || t.includes('service') || t.includes('runtime') || t.includes('secret') || t.includes('governance') || t.includes('promotion') || t.includes('codex') || t.includes('metadata')) return 'System';
  if (t.includes('soccer')) return 'Soccer';
  return 'Other';
}

// ── Domain → color mapping (Crawler OS tag palette) ──────────────────────────

function domainColor(domain: string): { bg: string; fg: string; border: string } {
  const map: Record<string, { bg: string; fg: string; border: string }> = {
    'Odds & Betting':      { bg: 'rgba(6,182,212,0.08)',   fg: '#22D3EE', border: 'rgba(6,182,212,0.15)' },
    'Edge & Picks':        { bg: 'rgba(168,85,247,0.08)',  fg: '#C084FC', border: 'rgba(168,85,247,0.15)' },
    'Prediction Markets':  { bg: 'rgba(245,158,11,0.08)',  fg: '#FBBF24', border: 'rgba(245,158,11,0.15)' },
    'Player Stats':        { bg: 'rgba(16,185,129,0.08)',  fg: '#34D399', border: 'rgba(16,185,129,0.15)' },
    'Team Analytics':      { bg: 'rgba(59,130,246,0.08)',  fg: '#60A5FA', border: 'rgba(59,130,246,0.15)' },
    'Game Data':           { bg: 'rgba(123,175,212,0.08)', fg: '#7BAFD4', border: 'rgba(123,175,212,0.15)' },
    'Umpires':             { bg: 'rgba(244,63,94,0.08)',   fg: '#FB7185', border: 'rgba(244,63,94,0.15)' },
    'Context':             { bg: 'rgba(139,152,168,0.08)', fg: '#8B97A8', border: 'rgba(139,152,168,0.15)' },
    'External':            { bg: 'rgba(245,158,11,0.08)',  fg: '#FBBF24', border: 'rgba(245,158,11,0.15)' },
    'Infra':               { bg: 'rgba(100,116,139,0.08)', fg: '#94A3B8', border: 'rgba(100,116,139,0.15)' },
    'Identity':            { bg: 'rgba(139,92,246,0.08)',  fg: '#A78BFA', border: 'rgba(139,92,246,0.15)' },
    'System':              { bg: 'rgba(55,55,55,0.2)',     fg: '#555555', border: 'rgba(55,55,55,0.3)' },
    'Soccer':              { bg: 'rgba(16,185,129,0.08)',  fg: '#34D399', border: 'rgba(16,185,129,0.15)' },
  };
  return map[domain] || { bg: 'rgba(55,55,55,0.15)', fg: '#555', border: 'rgba(55,55,55,0.25)' };
}

// ── HTML generator (Crawler OS design system) ────────────────────────────────

function buildCensusHtml(census: Array<{
  table: string; rows: number; status: string; domain: string; isV2: boolean;
}>, summary: { totalTables: number; populated: number; sparse: number; empty: number; totalRows: number }) {
  
  const tableRows = census.map(t => {
    const dc = domainColor(t.domain);
    const statusDot = t.rows === 0
      ? '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#F43F5E;box-shadow:0 0 6px rgba(244,63,94,0.4)"></span>'
      : t.rows < 100
        ? '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#FBBF24;box-shadow:0 0 6px rgba(245,158,11,0.4)"></span>'
        : '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#10B981;box-shadow:0 0 6px rgba(16,185,129,0.4)"></span>';
    
    const v2Badge = t.isV2
      ? '<span style="font-family:var(--font-mono);font-size:9px;padding:2px 6px;border-radius:4px;background:rgba(6,182,212,0.08);color:#22D3EE;border:1px solid rgba(6,182,212,0.15)">V2</span>'
      : '';

    return `<tr>
      <td style="padding:10px 16px;border-bottom:1px solid var(--b1);text-align:center">${statusDot}</td>
      <td style="padding:10px 16px;border-bottom:1px solid var(--b1);font-family:var(--font-mono);font-size:12px;color:var(--t1);font-weight:500">${t.table} ${v2Badge}</td>
      <td style="padding:10px 16px;border-bottom:1px solid var(--b1);font-family:var(--font-mono);font-size:12px;color:${t.rows === 0 ? 'var(--t4)' : 'var(--t1)'};text-align:right;font-weight:600">${t.rows.toLocaleString()}</td>
      <td style="padding:10px 16px;border-bottom:1px solid var(--b1)">
        <span style="font-family:var(--font-mono);font-size:10px;font-weight:600;padding:3px 10px;border-radius:20px;background:${dc.bg};color:${dc.fg};border:1px solid ${dc.border};white-space:nowrap">${t.domain}</span>
      </td>
    </tr>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>MLB Database Census — sports-mlb-db</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #000000;
      --s1: #080808;
      --s2: #0F0F0F;
      --s3: #161616;
      --b1: #1A1A1A;
      --b2: #252525;
      --t1: #FFFFFF;
      --t2: #A0A0A0;
      --t3: #555555;
      --t4: #333333;
      --nc: #7BAFD4;
      --t-radius-sm: 6px;
      --t-radius-md: 10px;
      --t-radius-lg: 14px;
      --font-sans: 'Inter', -apple-system, system-ui, sans-serif;
      --font-mono: 'JetBrains Mono', 'Fira Code', monospace;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    *::-webkit-scrollbar { width: 6px; height: 6px; }
    *::-webkit-scrollbar-track { background: var(--bg); }
    *::-webkit-scrollbar-thumb { background: var(--b2); border-radius: 3px; }
    body {
      background-color: var(--bg);
      color: var(--t2);
      font-family: var(--font-sans);
      font-size: 14px;
      line-height: 1.5;
      -webkit-font-smoothing: antialiased;
      min-height: 100vh;
      padding: 32px;
    }
    .container { max-width: 1000px; margin: 0 auto; }

    /* Header */
    .header { margin-bottom: 32px; }
    .header h1 {
      font-size: 22px; font-weight: 800; color: var(--t1);
      letter-spacing: -0.5px; margin-bottom: 6px;
      display: flex; align-items: center; gap: 10px;
    }
    .header h1 span { color: var(--nc); font-weight: 400; }
    .header p { font-size: 12px; color: var(--t3); }

    /* Stat Cards */
    .stats-row {
      display: grid; grid-template-columns: repeat(5, 1fr); gap: 12px;
      margin-bottom: 28px;
    }
    .stat-card {
      background-color: var(--s1);
      border: 1px solid var(--b1);
      border-radius: var(--t-radius-md);
      padding: 16px;
      transition: all 0.15s ease;
    }
    .stat-card:hover { border-color: var(--b2); background-color: #0c0c0c; }
    .stat-value {
      font-size: 24px; font-weight: 800; color: var(--t1);
      font-family: var(--font-mono); letter-spacing: -1px;
    }
    .stat-value.green { color: #34D399; }
    .stat-value.amber { color: #FBBF24; }
    .stat-value.rose { color: #FB7185; }
    .stat-value.cyan { color: var(--nc); }
    .stat-label {
      font-size: 10px; font-weight: 600; color: var(--t3);
      text-transform: uppercase; letter-spacing: 1px; margin-top: 4px;
    }

    /* Filter bar */
    .filter-bar {
      display: flex; align-items: center; gap: 12px; margin-bottom: 16px;
    }
    .search-box {
      background-color: var(--s1); border: 1px solid var(--b1);
      border-radius: var(--t-radius-sm); padding: 2px 14px;
      flex: 1; max-width: 320px;
    }
    .search-box input {
      background: transparent; border: none; outline: none;
      color: var(--t1); font-size: 12px; width: 100%; height: 36px;
      font-family: var(--font-sans);
    }
    .search-box input::placeholder { color: var(--t4); }
    .filter-btn {
      font-family: var(--font-mono); font-size: 10px; font-weight: 600;
      padding: 8px 14px; border-radius: 20px; cursor: pointer;
      border: 1px solid var(--b1); background: var(--s1); color: var(--t3);
      transition: all 0.15s ease; text-transform: uppercase; letter-spacing: 0.5px;
    }
    .filter-btn:hover { border-color: var(--b2); color: var(--t2); background: var(--s2); }
    .filter-btn.active { background: rgba(123,175,212,0.08); color: var(--nc); border-color: rgba(123,175,212,0.15); }

    /* Table */
    .table-wrap {
      background-color: var(--s1);
      border: 1px solid var(--b1);
      border-radius: var(--t-radius-lg);
      overflow: hidden;
    }
    table { width: 100%; border-collapse: collapse; }
    thead th {
      padding: 12px 16px; text-align: left;
      font-size: 10px; font-weight: 700; color: var(--t4);
      text-transform: uppercase; letter-spacing: 1px;
      border-bottom: 1px solid var(--b1); background-color: var(--s2);
    }
    tbody tr { transition: background-color 0.1s ease; }
    tbody tr:hover { background-color: var(--s2); }
    tbody tr:hover td { color: var(--t1); }

    /* Footer */
    .footer {
      margin-top: 24px; padding-top: 16px;
      border-top: 1px solid var(--b1);
      display: flex; justify-content: space-between; align-items: center;
    }
    .footer span { font-size: 10px; color: var(--t4); font-family: var(--font-mono); }

    @media (max-width: 768px) {
      .stats-row { grid-template-columns: repeat(2, 1fr); }
      body { padding: 16px; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>📊 MLB Database Census <span>sports-mlb-db</span></h1>
      <p>Spanner instance: clearspace · ${summary.totalTables} tables · ${summary.totalRows.toLocaleString()} total rows · Queried ${new Date().toISOString().replace('T', ' at ').split('.')[0]} UTC</p>
    </div>

    <div class="stats-row">
      <div class="stat-card">
        <div class="stat-value cyan">${summary.totalTables}</div>
        <div class="stat-label">Total Tables</div>
      </div>
      <div class="stat-card">
        <div class="stat-value green">${summary.populated}</div>
        <div class="stat-label">Populated</div>
      </div>
      <div class="stat-card">
        <div class="stat-value amber">${summary.sparse}</div>
        <div class="stat-label">Sparse</div>
      </div>
      <div class="stat-card">
        <div class="stat-value rose">${summary.empty}</div>
        <div class="stat-label">Empty</div>
      </div>
      <div class="stat-card">
        <div class="stat-value" style="font-size:18px">${summary.totalRows.toLocaleString()}</div>
        <div class="stat-label">Total Rows</div>
      </div>
    </div>

    <div class="filter-bar">
      <div class="search-box">
        <input type="text" id="search" placeholder="Filter tables..." oninput="filterTable()">
      </div>
      <button class="filter-btn active" data-filter="all" onclick="setFilter('all',this)">All</button>
      <button class="filter-btn" data-filter="populated" onclick="setFilter('populated',this)">🟢 Populated</button>
      <button class="filter-btn" data-filter="sparse" onclick="setFilter('sparse',this)">🟡 Sparse</button>
      <button class="filter-btn" data-filter="empty" onclick="setFilter('empty',this)">🔴 Empty</button>
    </div>

    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th style="width:50px;text-align:center">Status</th>
            <th>Table</th>
            <th style="text-align:right">Rows</th>
            <th style="width:160px">Domain</th>
          </tr>
        </thead>
        <tbody id="census-body">
          ${tableRows}
        </tbody>
      </table>
    </div>

    <div class="footer">
      <span>sports-mlb-db · clearspace instance · gen-lang-client-0281999829</span>
      <span>${summary.populated}/${summary.totalTables} tables have data</span>
    </div>
  </div>

  <script>
    let currentFilter = 'all';
    function setFilter(f, btn) {
      currentFilter = f;
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      filterTable();
    }
    function filterTable() {
      const q = document.getElementById('search').value.toLowerCase();
      const rows = document.querySelectorAll('#census-body tr');
      rows.forEach(row => {
        const name = row.children[1]?.textContent?.toLowerCase() || '';
        const domain = row.children[3]?.textContent?.toLowerCase() || '';
        const rowCount = parseInt(row.children[2]?.textContent?.replace(/,/g, '') || '0');
        let statusMatch = true;
        if (currentFilter === 'populated') statusMatch = rowCount >= 100;
        else if (currentFilter === 'sparse') statusMatch = rowCount > 0 && rowCount < 100;
        else if (currentFilter === 'empty') statusMatch = rowCount === 0;
        const textMatch = !q || name.includes(q) || domain.includes(q);
        row.style.display = (statusMatch && textMatch) ? '' : 'none';
      });
    }
  </script>
</body>
</html>`;
}

// ── Tool definition ──────────────────────────────────────────────────────────

export const mlbTablesTools: RegisteredTool<any>[] = [
  {
    definition: {
      name: 'mlb_tables_census',
      description: `Returns a complete census of every table in the sports-mlb-db Spanner database, rendered as a premium Crawler OS styled HTML artifact.

For each table: name, row count, status (🟢/🟡/🔴), domain, and V2 tag.

Use when:
- User asks about database status, table health, or data coverage
- You need to know which tables have data before querying them
- Generating a data infrastructure report`,
      schema: z.object({
        filter: z.enum(['all', 'populated', 'empty', 'sparse']).optional()
          .describe("Filter tables by status. Default: 'all'"),
      }),
    },
    handler: async (args) => {
      const instance = spanner.instance(env.SPANNER_INSTANCE_ID);
      const database = instance.database('sports-mlb-db');

      try {
        // Step 1: Get all table names
        const [tableRows] = await database.run({
          sql: `SELECT TABLE_NAME, TABLE_TYPE FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = '' ORDER BY TABLE_NAME`,
        });

        const baseTables = tableRows
          .map((r: any) => {
            const j = r.toJSON ? r.toJSON() : r;
            return { name: j.TABLE_NAME, type: j.TABLE_TYPE };
          })
          .filter((t: any) => t.type === 'BASE TABLE' && !t.name.startsWith('Metadata_'));

        // Step 2: Count rows (batched)
        const census: Array<{ table: string; rows: number; status: string; domain: string; isV2: boolean }> = [];

        const batchSize = 15;
        for (let i = 0; i < baseTables.length; i += batchSize) {
          const batch = baseTables.slice(i, i + batchSize);
          const sql = batch.map((t: any) => `SELECT '${t.name}' AS tbl, COUNT(*) AS cnt FROM \`${t.name}\``).join(' UNION ALL ');
          const [rows] = await database.run({ sql });
          for (const row of rows) {
            const json = row.toJSON ? row.toJSON() : row;
            const name = json.tbl;
            const count = typeof json.cnt === 'object' ? parseInt(json.cnt.value) : parseInt(json.cnt);
            census.push({
              table: name,
              rows: count,
              status: count === 0 ? 'empty' : count < 100 ? 'sparse' : 'populated',
              domain: classifyDomain(name),
              isV2: name.includes('V2') || name.includes('v2'),
            });
          }
        }

        // Sort: populated first, then by row count desc
        census.sort((a, b) => b.rows - a.rows);

        // Summary stats
        const totalTables = census.length;
        const populated = census.filter(t => t.status === 'populated').length;
        const sparse = census.filter(t => t.status === 'sparse').length;
        const empty = census.filter(t => t.status === 'empty').length;
        const totalRows = census.reduce((sum, t) => sum + t.rows, 0);

        // Step 3: Generate HTML artifact
        const html = buildCensusHtml(census, { totalTables, populated, sparse, empty, totalRows });

        // Step 4: Upload to GCS
        const artifactId = `mlb-census-${randomUUID().split('-')[0]}`;
        const objectName = `${ARTIFACT_PREFIX}/${artifactId}.html`;

        try {
          await callGcpMcpTool(STORAGE_MCP, 'write_text', {
            bucketName: ARTIFACT_BUCKET,
            objectName,
            textContent: html,
            contentType: 'text/html; charset=utf-8',
          });
        } catch (err: any) {
          logger.warn({ msg: 'mlb_tables_census: GCS upload failed, returning inline', err: err.message });
        }

        const previewUrl = `https://storage.googleapis.com/${ARTIFACT_BUCKET}/${objectName}`;

        logger.info({ msg: 'mlb_tables_census', totalTables, populated, sparse, empty, totalRows });

        return {
          summary: { totalTables, populated, sparse, empty, totalRows: totalRows.toLocaleString() },
          previewUrl,
          artifactId,
          tables: census.map(t => ({
            status: t.rows === 0 ? '🔴' : t.rows < 100 ? '🟡' : '🟢',
            table: t.table,
            rows: t.rows.toLocaleString(),
            domain: t.domain,
            isV2: t.isV2 ? '✓' : '',
          })),
        };
      } catch (err: any) {
        logger.error({ msg: 'mlb_tables_census.error', err: err.message });
        return { error: `Census failed: ${err.message}` };
      } finally {
        await database.close();
      }
    },
    render: {
      renderType: 'table',
      title: '📊 MLB Database Census',
      dataKey: 'tables',
      columns: [
        { key: 'status', label: 'Status', align: 'center' },
        { key: 'table', label: 'Table', align: 'left' },
        { key: 'rows', label: 'Rows', align: 'right', format: 'number' },
        { key: 'domain', label: 'Domain', align: 'left' },
        { key: 'isV2', label: 'V2', align: 'center' },
      ],
    },
    promptHint: `Present this as a database health report. Always include the previewUrl link so the user can view the full interactive table. Highlight the V2 migration gap and which domains have empty tables.`,
  },
];
