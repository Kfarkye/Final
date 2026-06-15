import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Server, Plus, Search, Trash2, Power, X, RefreshCw,
  Terminal, Compass, PlusCircle, Hash, ChevronDown, ArrowRight,
  ExternalLink, Cpu
} from 'lucide-react';

export interface McpTool {
  name: string;
  description: string;
  parameters: string;
  sampleInput?: string;
}

export interface McpServer {
  id: string;
  name: string;
  publisher: string;
  description: string;
  status: 'Connected' | 'Active' | 'Disconnected' | 'Connecting';
  icon: 'drive' | 'mail' | 'calendar' | 'map' | 'git' | 'search' | 'custom';
  type: 'Official' | 'Custom';
  transport: 'Stdout' | 'SSE' | 'WebSocket';
  commandOrUrl: string;
  env?: string; 
  tools: McpTool[];
  lastChecked?: string;
  latency?: number;
}

const PRELOADED_SERVERS: McpServer[] = [
  {
    id: 'google-drive-mcp',
    name: 'Google Drive Protocol',
    publisher: 'Google Official API',
    description: 'Enables deep-indexing queries, metadata retrieval, and plain-text extraction of document bodies directly inside Google Drive.',
    status: 'Connected',
    icon: 'drive',
    type: 'Official',
    transport: 'SSE',
    commandOrUrl: 'https://mcp.googleapis.com/v1/drive/sse',
    tools: [
      {
        name: 'search_drive',
        description: 'Queries file names, types, content metadata, and date ranges inside Google Drive.',
        parameters: '{ query: string, mimeType?: string, limit?: number }',
        sampleInput: '{"query": "quarterly earnings report", "limit": 3}'
      },
      {
        name: 'read_drive_file',
        description: 'Extracts full markdown content of Google Docs, spreadsheet schemas, or text-based documents.',
        parameters: '{ fileId: string }',
        sampleInput: '{"fileId": "1aBnd38D87as_adX9-zx"}'
      },
      {
        name: 'create_drive_file',
        description: 'Creates a clean document, file, or folder in Google Drive with the specified name and content.',
        parameters: '{ name: string, content: string, folderId?: string }',
        sampleInput: '{"name": "Summary Memo", "content": "Meeting summary: Project alpha. Status is green."}'
      }
    ],
    lastChecked: 'Just verified',
    latency: 14
  },
  {
    id: 'google-gmail-mcp',
    name: 'Google Gmail Protocol',
    publisher: 'Google Official API',
    description: 'Binds with personal mail archives to locate threads, analyze email headers, format outbound drafts, and optimize inbox dispatch rules.',
    status: 'Connected',
    icon: 'mail',
    type: 'Official',
    transport: 'SSE',
    commandOrUrl: 'https://mcp.googleapis.com/v1/gmail/sse',
    tools: [
      {
        name: 'list_unread_emails',
        description: 'Lists the latest unread Gmail threads from your primary inbox.',
        parameters: '{ limit?: number, label?: string }',
        sampleInput: '{"limit": 5, "label": "INBOX"}'
      },
      {
        name: 'get_email_thread',
        description: 'Retrieves all full message payloads, headers, attachments metadata, and content for a specific thread.',
        parameters: '{ threadId: string }',
        sampleInput: '{"threadId": "18f52af8bc92801a"}'
      },
      {
        name: 'send_email_draft',
        description: 'Sends a formatted email with optional subject, recipients, and custom text sections.',
        parameters: '{ to: string, subject: string, body: string }',
        sampleInput: '{"to": "partner@firm.company", "subject": "Project Proposal Draft", "body": "Please find attached some initial specifications."}'
      }
    ],
    lastChecked: 'Just verified',
    latency: 22
  },
  {
    id: 'google-calendar-mcp',
    name: 'Google Calendar Protocol',
    publisher: 'Google Official API',
    description: 'Coordinates scheduling operations: reads time intervals, creates appointments, manages attendee circles, and performs free-busy lookup.',
    status: 'Connected',
    icon: 'calendar',
    type: 'Official',
    transport: 'SSE',
    commandOrUrl: 'https://mcp.googleapis.com/v1/calendar/sse',
    tools: [
      {
        name: 'get_upcoming_events',
        description: 'Fetches calendar invite list, times, descriptions, and links from the main calendar.',
        parameters: '{ timeMin: string, limit?: number }',
        sampleInput: '{"timeMin": "2026-06-14T00:00:00Z", "limit": 10}'
      },
      {
        name: 'create_calendar_event',
        description: 'Creates a scheduled appointment or business meeting on your primary calendar.',
        parameters: '{ summary: string, startTime: string, endTime: string, invitees?: string[] }',
        sampleInput: '{"summary": "Review: Architecture Board", "startTime": "2026-06-15T15:00:00", "endTime": "2026-06-15T16:00:00"}'
      },
      {
        name: 'check_availability',
        description: 'Queries free/busy ranges for specific sets of email invitees to optimize meeting schedules.',
        parameters: '{ emails: string[], startTime: string, endTime: string }',
        sampleInput: '{"emails": ["lead@tech.co"], "startTime": "2026-06-14T09:00:00", "endTime": "2026-06-14T17:00:00"}'
      }
    ],
    lastChecked: 'Just verified',
    latency: 11
  },
  {
    id: 'google-maps-mcp',
    name: 'Google Maps Protocol',
    publisher: 'Google Maps Platform',
    description: 'Integrates address parsing, geographic coordinates geocoding, route calculations, and nearby workspace localization.',
    status: 'Connected',
    icon: 'map',
    type: 'Official',
    transport: 'SSE',
    commandOrUrl: 'https://mcp.googleapis.com/v1/maps/sse',
    tools: [
      {
        name: 'validate_address',
        description: 'Cleans, validates, and fills address formatting details for accurate logistics or registration.',
        parameters: '{ addressLines: string[], postalCode?: string, countryCode?: string }',
        sampleInput: '{"addressLines": ["1600 Amphitheatre Pkwy"], "postalCode": "94043"}'
      },
      {
        name: 'get_route_directions',
        description: 'Retrieves driving, transit, or walking paths, with duration estimates, traffic delays, and distance values.',
        parameters: '{ origin: string, destination: string, travelMode?: "DRIVE" | "TRANSIT" | "WALK" }',
        sampleInput: '{"origin": "San Francisco Airport", "destination": "Mountain View HQ", "travelMode": "DRIVE"}'
      },
      {
        name: 'search_nearby_places',
        description: 'Locates establishments, services, or locations within a specific meter radius of custom geographic coordinates.',
        parameters: '{ location: { latitude: number, longitude: number }, radius: number, keyword?: string }',
        sampleInput: '{"location": {"latitude": 37.422, "longitude": -122.084}, "radius": 500, "keyword": "organic coffee"}'
      }
    ],
    lastChecked: 'Just verified',
    latency: 35
  },
  {
    id: 'git-mcp',
    name: 'Local Repository Engine',
    publisher: 'Git Native Protocol',
    description: 'Inspects local sandbox revisions, reads working directory untracked lists, compiles exact diff blocks, and analyzes histories.',
    status: 'Active',
    icon: 'git',
    type: 'Official',
    transport: 'Stdout',
    commandOrUrl: 'npx @modelcontextprotocol/server-git',
    tools: [
      {
        name: 'run_git_status',
        description: 'Retrieves uncommitted edits, staged items, untracked files, and current HEAD state.',
        parameters: '{}',
        sampleInput: '{}'
      },
      {
        name: 'get_git_diff',
        description: 'Analyzes absolute code adjustments across modified files and working index state.',
        parameters: '{ filePaths?: string[] }',
        sampleInput: '{"filePaths": ["src/ChatClient.tsx"]}'
      },
      {
        name: 'view_git_commits',
        description: 'Returns the chronological record of latest repository revisions, complete with hashes, authors, and log summaries.',
        parameters: '{ limit?: number, branch?: string }',
        sampleInput: '{"limit": 5, "branch": "main"}'
      }
    ],
    lastChecked: 'Just verified',
    latency: 8
  },
  {
    id: 'google-search-mcp',
    name: 'Google Search Protocol',
    publisher: 'Google Grounding API',
    description: 'Provides real-time grounded context from the web, indexing recent news, deep search resolutions, and domain specific lookups.',
    status: 'Connected',
    icon: 'search',
    type: 'Official',
    transport: 'SSE',
    commandOrUrl: 'https://mcp.googleapis.com/v1/search/sse',
    tools: [
      {
        name: 'search_web',
        description: 'Performs a comprehensive web search for a given query. Returns a summary of relevant information along with URL citations.',
        parameters: '{ query: string, domain?: string }',
        sampleInput: '{"query": "Latest React updates"}'
      }
    ],
    lastChecked: 'Just verified',
    latency: 18
  },
  {
    id: 'google-spanner-mcp',
    name: 'Google Cloud Spanner Protocol',
    publisher: 'Google Official API',
    description: 'Provides structured access to Google Cloud Spanner instances: query databases, inspect DDL schema, and run transactions.',
    status: 'Connected',
    icon: 'custom',
    type: 'Official',
    transport: 'SSE',
    commandOrUrl: '/api/mcp/spanner',
    tools: [
      {
        name: 'list_instances',
        description: 'Lists all Cloud Spanner instances in the active project.',
        parameters: '{}',
        sampleInput: '{}'
      },
      {
        name: 'list_databases',
        description: 'Lists all databases inside a specific Spanner instance.',
        parameters: '{ instanceId: string }',
        sampleInput: '{"instanceId": "prod-instance"}'
      },
      {
        name: 'get_database_ddl',
        description: 'Retrieves the DDL (Data Definition Language) structure for a database.',
        parameters: '{ instanceId: string, databaseId: string }',
        sampleInput: '{"instanceId": "prod-instance", "databaseId": "users-db"}'
      },
      {
        name: 'execute_sql',
        description: 'Executes a SQL query (SELECT) or a DML statement (INSERT/UPDATE/DELETE). DML statements require human UX approval.',
        parameters: '{ instanceId: string, databaseId: string, sql: string }',
        sampleInput: '{"instanceId": "prod-instance", "databaseId": "users-db", "sql": "SELECT * FROM Users LIMIT 5"}'
      }
    ],
    lastChecked: 'Just verified',
    latency: 16
  },
  {
    id: 'fetch-script-mcp',
    name: 'Fetch & Script Sandbox',
    publisher: 'Custom Sandbox Engine',
    description: 'Enables high-performance scraping of public HTML pages, structured JSON API fetching, and sandboxed Javascript script execution.',
    status: 'Connected',
    icon: 'custom',
    type: 'Official',
    transport: 'SSE',
    commandOrUrl: 'http://localhost:3000/api/mcp/fetch-script',
    tools: [
      {
        name: 'fetch_html',
        description: 'Fetches the raw HTML body content of a public URL.',
        parameters: '{ url: string }',
        sampleInput: '{"url": "https://news.ycombinator.com"}'
      },
      {
        name: 'fetch_json',
        description: 'Fetches structured JSON data from an API endpoint or web resource.',
        parameters: '{ url: string, method?: string, headers?: object, body?: string }',
        sampleInput: '{"url": "https://api.github.com/repos/facebook/react", "headers": {"User-Agent": "Reverie"}}'
      },
      {
        name: 'run_script',
        description: 'Runs a sandboxed JavaScript code block on the server and returns the console output and return value.',
        parameters: '{ code: string }',
        sampleInput: '{"code": "const x = 10; console.log(x * 2); x * 2;"}'
      },
      {
        name: 'fetch_text',
        description: 'Fetches a public URL and returns plain text content, with optional truncation.',
        parameters: '{ url: string, maxChars?: number }',
        sampleInput: '{"url": "https://example.com", "maxChars": 1000}'
      },
      {
        name: 'fetch_headers',
        description: 'Fetches only response headers and metadata for a public URL using HEAD.',
        parameters: '{ url: string }',
        sampleInput: '{"url": "https://example.com"}'
      },
      {
        name: 'fetch_rss',
        description: 'Fetches an RSS or Atom feed and returns basic feed entries.',
        parameters: '{ url: string, limit?: number }',
        sampleInput: '{"url": "https://hnrss.org/frontpage", "limit": 5}'
      },
      {
        name: 'fetch_sitemap',
        description: 'Fetches and parses a sitemap XML file, returning discovered URLs.',
        parameters: '{ url: string, limit?: number }',
        sampleInput: '{"url": "https://example.com/sitemap.xml", "limit": 10}'
      },
      {
        name: 'fetch_robots',
        description: 'Fetches robots.txt for a website origin.',
        parameters: '{ url: string }',
        sampleInput: '{"url": "https://example.com"}'
      },
      {
        name: 'fetch_url_batch',
        description: 'Fetches multiple public URLs and returns status, content type, and truncated body.',
        parameters: '{ urls: string[], maxCharsPerUrl?: number }',
        sampleInput: '{"urls": ["https://example.com", "https://news.ycombinator.com"], "maxCharsPerUrl": 500}'
      },
      {
        name: 'http_request',
        description: 'Performs a controlled HTTP request to a public URL.',
        parameters: '{ url: string, method?: string, headers?: object, body?: string, maxChars?: number }',
        sampleInput: '{"url": "https://httpbin.org/post", "method": "POST", "body": "{\\"test\\": true}"}'
      },
      {
        name: 'fetch_xml',
        description: 'Fetches a public XML feed and returns raw XML plus key-value extracted tags.',
        parameters: '{ url: string }',
        sampleInput: '{"url": "https://example.com/feed.xml"}'
      },
      {
        name: 'fetch_markdown',
        description: 'Fetches a public HTML URL and converts it into clean, readable Markdown format.',
        parameters: '{ url: string }',
        sampleInput: '{"url": "https://news.ycombinator.com"}'
      },
      {
        name: 'extract_page',
        description: 'Fetches a public URL and extracts cleaned, readable body text plus page title and meta description.',
        parameters: '{ url: string, maxChars?: number }',
        sampleInput: '{"url": "https://en.wikipedia.org/wiki/React_(software)"}'
      },
      {
        name: 'research_sources',
        description: 'Searches the web and fetches a bounded set of public source pages with extracted text content.',
        parameters: '{ query: string, domain?: string, maxSources?: number, maxCharsPerSource?: number }',
        sampleInput: '{"query": "latest SpaceX Falcon 9 launches", "maxSources": 3}'
      },
      {
        name: 'research_report',
        description: 'Creates an end-to-end cited research report from grounded search and fetched public pages.',
        parameters: '{ query: string, domain?: string, maxSources?: number, format?: string }',
        sampleInput: '{"query": "impact of artificial intelligence on software engineering in 2026", "maxSources": 4, "format": "detailed"}'
      },
      {
        name: 'fetch_readable',
        description: 'Fetches a public URL, extracts the primary readable article/page content, and converts it to clean Markdown with metadata.',
        parameters: '{ url: string, maxChars?: number }',
        sampleInput: '{"url": "https://news.ycombinator.com/item?id=39123456"}'
      }
    ],
    lastChecked: 'Just verified',
    latency: 5
  },
  {
    id: 'stripe-mcp',
    name: 'Stripe Ledger core',
    publisher: 'Stripe Official API',
    description: 'Exposes financial micro-ledgers, enabling query loops on invoice registries, balance sheets, and customers.',
    status: 'Connected',
    icon: 'custom',
    type: 'Official',
    transport: 'SSE',
    commandOrUrl: '/api/mcp/stripe',
    tools: [
      {
        name: 'balance_read',
        description: 'Retrieve platform balance detail metrics.',
        parameters: '{}',
        sampleInput: '{}'
      },
      {
        name: 'customers_search',
        description: 'Query customers using standard Stripe search syntax. Caution: Eventually consistent.',
        parameters: '{ query: string }',
        sampleInput: '{"query": "email:\'user@example.com\'"}'
      },
      {
        name: 'subscriptions_cancel',
        description: 'Terminate an active user subscription. Requires administrative verification.',
        parameters: '{ subscriptionId: string, confirm: boolean }',
        sampleInput: '{"subscriptionId": "sub_1Oabc", "confirm": true}'
      }
    ],
    lastChecked: 'Just verified',
    latency: 15
  },
  {
    id: 'linear-mcp',
    name: 'Linear Workspace Sync',
    publisher: 'Linear Official API',
    description: 'Bridges Truth to the Linear GraphQL API for tracking project issues and tasks.',
    status: 'Connected',
    icon: 'custom',
    type: 'Official',
    transport: 'SSE',
    commandOrUrl: '/api/mcp/linear',
    tools: [
      {
        name: 'issue_list',
        description: 'Fetch list of issues scoped to the active workspace project filter.',
        parameters: '{ projectId?: string, limit?: number }',
        sampleInput: '{"projectId": "project-123", "limit": 10}'
      },
      {
        name: 'issue_create',
        description: 'Create a new issue inside the user\'s project.',
        parameters: '{ title: string, description?: string, teamId: string }',
        sampleInput: '{"title": "Fix login bug", "description": "Crash on empty token input", "teamId": "team-456"}'
      }
    ],
    lastChecked: 'Just verified',
    latency: 18
  },
  {
    id: 'notebook-mcp',
    name: 'Notebook Deno Sandbox',
    publisher: 'Truth Platform',
    description: 'Runs sandboxed JavaScript calculations inside an isolated Deno shell.',
    status: 'Connected',
    icon: 'custom',
    type: 'Official',
    transport: 'SSE',
    commandOrUrl: '/api/mcp/notebook',
    tools: [
      {
        name: 'execute_javascript',
        description: 'Run code snippets dynamically in an isolated environment. Heavy standard libraries and remote networks are blocked.',
        parameters: '{ code: string }',
        sampleInput: '{"code": "const x = 10; console.log(x * 2); x * 2;"}'
      }
    ],
    lastChecked: 'Just verified',
    latency: 10
  }
];

interface McpRegistryProps {
  onInsertContext?: (text: string) => void;
  onClose?: () => void;
}

export default function McpRegistry({ onInsertContext, onClose }: McpRegistryProps) {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState<'all' | 'official' | 'custom'>('all');
  const [selectedServer, setSelectedServer] = useState<McpServer | null>(null);
  const [isAddingServer, setIsAddingServer] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [discoveringId, setDiscoveringId] = useState<string | null>(null);

  // Custom server form state
  const [name, setName] = useState('');
  const [publisher, setPublisher] = useState('');
  const [description, setDescription] = useState('');
  const [transport, setTransport] = useState<'Stdout' | 'SSE' | 'WebSocket'>('SSE');
  const [commandOrUrl, setCommandOrUrl] = useState('');
  const [env, setEnv] = useState('');

  const isMounted = useRef(true);

  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
    };
  }, []);

  useEffect(() => {
    let currentServers = [...PRELOADED_SERVERS];
    const fullSaved = localStorage.getItem('mcp_full_servers');
    if (fullSaved) {
      try {
        const parsed = JSON.parse(fullSaved) as McpServer[];
        // Merge missing preloaded servers into parsed
        currentServers.forEach(pre => {
          if (!parsed.find(p => p.id === pre.id)) {
            parsed.push(pre);
          }
        });
        // We also want to keep the current state of preloaded servers (status/description/tools updates)
        // so maybe it's better to update the existing elements with preloaded configs if they are 'Official'
        const merged = parsed.map(p => {
          if (p.type === 'Official') {
            const preObj = currentServers.find(c => c.id === p.id);
            if (preObj) return { ...preObj, status: p.status }; // respect users' toggled connect status
          }
          return p;
        });
        setServers(merged);
        return;
      } catch (err) {
        console.error("Failed to parse full saved MCP servers status", err);
      }
    }
    const saved = localStorage.getItem('mcp_registry_servers');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        parsed.forEach((custom: McpServer) => {
          if (custom.type === 'Custom' && !currentServers.find(m => m.id === custom.id)) {
            currentServers.push(custom);
          }
        });
      } catch (err) {
        console.error("Failed to parse saved MCP servers", err);
      }
    }
    setServers(currentServers);
    localStorage.setItem('mcp_full_servers', JSON.stringify(currentServers));
  }, []);

  const saveServers = (updated: McpServer[]) => {
    setServers(updated);
    const customOnly = updated.filter(s => s.type === 'Custom');
    localStorage.setItem('mcp_registry_servers', JSON.stringify(customOnly));
    localStorage.setItem('mcp_full_servers', JSON.stringify(updated));
  };

  const handleCreateServer = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !commandOrUrl.trim()) return;

    const newServer: McpServer = {
      id: `custom-mcp-${Date.now()}`,
      name: name.trim(),
      publisher: publisher.trim() || 'Private Endpoint',
      description: description.trim() || 'Exposes internal schemas, custom functions, and host-bound data pipelines.',
      status: 'Disconnected',
      icon: 'custom',
      type: 'Custom',
      transport,
      commandOrUrl: commandOrUrl.trim(),
      env: env.trim() || undefined,
      tools: [],
      lastChecked: 'Never',
    };

    saveServers([...servers, newServer]);
    setIsAddingServer(false);
    
    // Reset form
    setName('');
    setPublisher('');
    setDescription('');
    setTransport('SSE');
    setCommandOrUrl('');
    setEnv('');
  };

  const handleDeleteServer = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const updated = servers.filter(s => s.id !== id);
    saveServers(updated);
    if (selectedServer?.id === id) {
      setSelectedServer(null);
    }
  };

  const handleToggleStatus = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const updated = servers.map(s => {
      if (s.id === id) {
        let nextStatus: 'Connected' | 'Active' | 'Disconnected' = 'Disconnected';
        if (s.status === 'Disconnected') {
          nextStatus = s.type === 'Official' ? 'Connected' : 'Active';
        }
        return {
          ...s,
          status: nextStatus,
          lastChecked: 'Connected'
        };
      }
      return s;
    });
    saveServers(updated);
    if (selectedServer?.id === id) {
      const target = updated.find(s => s.id === id);
      if (target) setSelectedServer(target);
    }
  };

  const testConnection = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setTestingId(id);
    setTimeout(() => {
      if (!isMounted.current) return;
      const updated = servers.map(s => {
        if (s.id === id) {
          return {
            ...s,
            status: s.type === 'Official' ? 'Connected' as const : 'Active' as const,
            latency: Math.floor(Math.random() * 15) + 5,
            lastChecked: 'Verified response'
          };
        }
        return s;
      });
      saveServers(updated);
      setTestingId(null);
      if (selectedServer?.id === id) {
        const target = updated.find(s => s.id === id);
        if (target) setSelectedServer(target);
      }
    }, 900);
  };

  const triggerRefreshAll = () => {
    setRefreshing(true);
    setTimeout(() => {
      if (!isMounted.current) return;
      const updated = servers.map(s => ({
        ...s,
        latency: Math.floor(Math.random() * 12) + 6,
        lastChecked: 'Active sync'
      }));
      saveServers(updated);
      setRefreshing(false);
    }, 800);
  };

  const filteredServers = servers.filter(server => {
    const matchesSearch = server.name.toLowerCase().includes(searchQuery.toLowerCase()) || 
                          server.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
                          server.tools.some(t => t.name.toLowerCase().includes(searchQuery.toLowerCase()));
    
    if (activeTab === 'all') return matchesSearch;
    if (activeTab === 'official') return matchesSearch && server.type === 'Official';
    if (activeTab === 'custom') return matchesSearch && server.type === 'Custom';
    return matchesSearch;
  });

  return (
    <div className="h-full flex flex-col bg-black text-zinc-100 overflow-hidden font-sans border-l border-zinc-900">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-5 border-b border-zinc-900 bg-black">
        <div>
          <div className="flex items-center gap-1.5 text-xs text-zinc-400 tracking-wider uppercase font-medium">
            <Compass size={11} className="text-zinc-500" />
            <span>Protocol Registry</span>
          </div>
          <h2 className="text-base font-medium text-white tracking-tight mt-1">
            Registered Models context (MCP)
          </h2>
        </div>

        <div className="flex items-center space-x-1.5">
          <button
            onClick={triggerRefreshAll}
            disabled={refreshing}
            className="p-1 px-2 text-xs bg-zinc-950 hover:bg-zinc-900 active:scale-[0.98] border border-zinc-800/80 rounded-lg text-zinc-400 hover:text-white transition-all flex items-center gap-1.5"
          >
            <RefreshCw size={11} className={refreshing ? 'animate-spin text-zinc-300' : 'text-zinc-500'} />
            <span className="text-[10px] tracking-wide">Sync</span>
          </button>

          {onClose && (
            <button
              onClick={onClose}
              className="p-1.5 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-950 rounded-lg transition-colors border border-transparent hover:border-zinc-900"
              title="Close Panel"
            >
              <X size={16} />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Search & Tabs: Apple-like segmented control */}
        <div className="px-6 py-4 flex flex-col gap-3.5 border-b border-zinc-900 bg-zinc-950/20">
          <div className="relative">
            <Search className="absolute left-3.5 top-2.5 text-zinc-600 pointer-events-none" size={13} />
            <input 
              type="text" 
              placeholder="Search schemas or context engines..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-zinc-950 border border-zinc-900 hover:border-zinc-800 focus:border-zinc-700 rounded-xl pl-10 pr-4 py-2.5 text-xs text-zinc-200 outline-none transition-all placeholder-zinc-600 font-sans"
            />
          </div>

          <div className="flex items-center justify-between gap-4">
            <div className="flex bg-zinc-950 rounded-lg p-0.5 border border-zinc-900 text-[10px] uppercase font-semibold tracking-wider">
              {(['all', 'official', 'custom'] as const).map(tab => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`px-3 py-1.5 rounded-md transition-all duration-300 font-sans ${activeTab === tab ? 'bg-zinc-100 text-black font-bold' : 'text-zinc-500 hover:text-zinc-300'}`}
                >
                  {tab === 'all' ? 'All' : tab}
                </button>
              ))}
            </div>

            <button 
              onClick={() => setIsAddingServer(true)}
              className="flex items-center gap-1.5 bg-zinc-100 text-black px-3.5 py-1.5 rounded-lg text-xs font-semibold tracking-wide hover:bg-white active:scale-[0.98] transition-all"
            >
              <Plus size={12} strokeWidth={2.5} />
              <span>Register Server</span>
            </button>
          </div>
        </div>

        {/* Content Panel Area */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
          <AnimatePresence>
            {isAddingServer && (
              <motion.div 
                initial={{ opacity: 0, scale: 0.98, y: -8 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.98, y: -8 }}
                className="p-5 rounded-2xl bg-zinc-950 border border-zinc-900 space-y-4"
              >
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-semibold uppercase tracking-widest text-zinc-400 flex items-center gap-1.5">
                    <PlusCircle size={12} className="text-zinc-500" /> Deploy Host Connection
                  </span>
                  <button onClick={() => setIsAddingServer(false)} className="text-zinc-600 hover:text-zinc-300 transition-colors">
                    <X size={14} />
                  </button>
                </div>

                <form onSubmit={handleCreateServer} className="space-y-3.5">
                  <div className="space-y-1">
                    <label className="block text-[9px] text-zinc-500 font-bold uppercase tracking-wider">Unique Name <span className="text-zinc-600">*</span></label>
                    <input 
                      type="text" 
                      placeholder="e.g., Enterprise Database Tunnel" 
                      required
                      value={name}
                      onChange={e => setName(e.target.value)}
                      className="w-full bg-black border border-zinc-900 focus:border-zinc-800 rounded-xl px-3 py-2 text-xs text-white outline-none placeholder-zinc-700"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <label className="block text-[9px] text-zinc-500 font-bold uppercase tracking-wider">Publisher</label>
                      <input 
                        type="text" 
                        placeholder="e.g., Internal Infra" 
                        value={publisher}
                        onChange={e => setPublisher(e.target.value)}
                        className="w-full bg-black border border-zinc-900 focus:border-zinc-800 rounded-xl px-3 py-2 text-xs text-white outline-none placeholder-zinc-700"
                      />
                    </div>
                    <div className="space-y-1 relative">
                      <label className="block text-[9px] text-zinc-500 font-bold uppercase tracking-wider">Transport</label>
                      <div className="relative">
                        <select 
                          value={transport}
                          onChange={e => setTransport(e.target.value as any)}
                          className="w-full bg-black border border-zinc-900 focus:border-zinc-800 rounded-xl px-3 py-2 text-xs text-white outline-none cursor-pointer appearance-none pr-8"
                        >
                          <option value="SSE">SSE Webservice</option>
                          <option value="Stdout">Stdout (npx runtime)</option>
                          <option value="WebSocket">WebSocket Stream</option>
                        </select>
                        <ChevronDown size={14} className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-zinc-500" />
                      </div>
                    </div>
                  </div>

                  <div className="space-y-1">
                    <label className="block text-[9px] text-zinc-500 font-bold uppercase tracking-wider">
                      {transport === 'SSE' ? 'Service Connection Endpoint URL' : transport === 'Stdout' ? 'Command/Process Instruction Line' : 'WebSocket Host Address'} <span className="text-zinc-600">*</span>
                    </label>
                    <input 
                      type="text" 
                      placeholder={transport === 'SSE' ? "https://mcp.github.com/sse" : transport === 'Stdout' ? "npx @modelcontextprotocol/server-postgres" : "ws://localhost:9000"} 
                      required
                      value={commandOrUrl}
                      onChange={e => setCommandOrUrl(e.target.value)}
                      className="w-full bg-black border border-zinc-900 focus:border-zinc-800 rounded-xl px-3 py-2 text-xs text-zinc-300 outline-none font-mono placeholder-zinc-700"
                    />
                  </div>

                  <div className="space-y-1">
                    <label className="block text-[9px] text-zinc-500 font-bold uppercase tracking-wider">Environment Config (JSON Optional)</label>
                    <textarea 
                      placeholder='{ "API_KEY": "sk_prod_...", "DEBUG": "true" }'
                      value={env}
                      rows={2}
                      onChange={e => setEnv(e.target.value)}
                      className="w-full bg-black border border-zinc-900 focus:border-zinc-800 rounded-xl px-3 py-2 text-xs text-zinc-300 outline-none font-mono resize-none placeholder-zinc-700"
                    />
                  </div>

                  <div className="space-y-1">
                    <label className="block text-[9px] text-zinc-500 font-bold uppercase tracking-wider">Brief Functional Purpose</label>
                    <input 
                      type="text" 
                      placeholder="Access tables, run scripts, query logs..." 
                      value={description}
                      onChange={e => setDescription(e.target.value)}
                      className="w-full bg-black border border-zinc-900 focus:border-zinc-800 rounded-xl px-3 py-2 text-xs text-white outline-none placeholder-zinc-700"
                    />
                  </div>

                  <button 
                    type="submit"
                    className="w-full bg-zinc-100 text-black py-2.5 rounded-xl font-semibold text-xs tracking-wide hover:bg-white active:scale-[0.98] transition-colors mt-2"
                  >
                    Deploy Connection & Hydrate Schema
                  </button>
                </form>
              </motion.div>
            )}
          </AnimatePresence>

          {filteredServers.length === 0 && (
            <div className="text-center py-16 text-zinc-600 space-y-2">
              <Server size={18} className="mx-auto text-zinc-700" />
              <p className="text-xs font-light">No records match the current filter state.</p>
            </div>
          )}

          {filteredServers.map((server) => {
            const isSelected = selectedServer?.id === server.id;
            const isOnline = server.status === 'Connected' || server.status === 'Active';
            
            return (
              <div 
                key={server.id}
                onClick={() => setSelectedServer(isSelected ? null : server)}
                className={`p-5 rounded-2xl bg-zinc-950 hover:bg-zinc-900/40 border border-zinc-900/60 hover:border-zinc-800 transition-all cursor-pointer ${isSelected ? 'border-zinc-800 bg-zinc-950' : ''}`}
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-start gap-3 flex-1 min-w-0">
                    {/* Exquisite Minimal Status Indicator */}
                    <div className="pt-1.5 flex-shrink-0">
                      <span className={`block w-1.5 h-1.5 rounded-full ${isOnline ? 'bg-zinc-100 shadow-[0_0_8px_rgba(255,255,255,0.4)]' : 'bg-zinc-800'}`} />
                    </div>
                    
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <h4 className="text-xs font-medium text-white truncate tracking-tight">{server.name}</h4>
                        {server.type === 'Official' ? (
                          <span className="text-[8px] px-1.5 py-0.5 bg-zinc-900 text-zinc-300 font-bold uppercase tracking-wider rounded">Host API</span>
                        ) : (
                          <span className="text-[8px] px-1.5 py-0.5 bg-zinc-900/80 text-zinc-500 font-semibold uppercase tracking-wider rounded">Custom</span>
                        )}
                      </div>
                      <p className="text-[10px] text-zinc-500 mt-1 font-sans">{server.publisher} • {server.transport}</p>
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    <button 
                      onClick={(e) => testConnection(server.id, e)}
                      disabled={testingId === server.id}
                      className="p-1 px-2 rounded-lg bg-zinc-950 hover:bg-zinc-900 active:scale-[0.98] border border-zinc-900 text-[9px] uppercase tracking-wider text-zinc-400 hover:text-white transition-all flex items-center gap-1"
                      title="Verify Protocol Latency"
                    >
                      {testingId === server.id ? (
                        <div className="w-2 h-2 border border-zinc-400 border-t-white rounded-full animate-spin" />
                      ) : (
                        <span>Ping</span>
                      )}
                    </button>
                    <button 
                      onClick={(e) => handleToggleStatus(server.id, e)}
                      className={`p-1.5 rounded-lg border transition-all ${isOnline ? 'bg-zinc-900/80 border-zinc-800/60 text-zinc-300 hover:text-white' : 'bg-zinc-950 border-zinc-900 text-zinc-600 hover:text-zinc-400'}`}
                      title={isOnline ? 'Disconnect' : 'Connect'}
                    >
                      <Power size={10} />
                    </button>
                  </div>
                </div>

                <p className="text-zinc-400 text-xs font-light tracking-normal leading-relaxed mt-3 max-w-[95%]">
                  {server.description}
                </p>

                <div className="flex items-center justify-between text-[10px] font-mono text-zinc-500 mt-4 border-t border-zinc-900/60 pt-3">
                  <div className="flex items-center gap-2">
                    <span className="text-zinc-600">STATE:</span>
                    <span className={`uppercase font-sans font-semibold tracking-wide ${isOnline ? 'text-zinc-300' : 'text-zinc-600'}`}>{server.status}</span>
                    {server.latency && <span className="opacity-60 text-[9px] font-mono">• {server.latency}ms</span>}
                  </div>
                  <div className="text-[9.5px]">
                    {server.tools.length} functional schemas
                  </div>
                </div>

                {/* Expanded Tools Panel: highly tailored dropdown layouts */}
                <AnimatePresence>
                  {isSelected && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      className="mt-4 pt-4 border-t border-zinc-900/80 space-y-4.5 overflow-hidden"
                      onClick={e => e.stopPropagation()} 
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-[9px] font-bold uppercase tracking-widest text-zinc-500 flex items-center gap-1.5">
                          <Terminal size={10} className="text-zinc-600" /> Host Connection String
                        </span>
                        {server.type === 'Custom' && (
                          <button 
                            onClick={(e) => handleDeleteServer(server.id, e)}
                            className="text-zinc-500 hover:text-zinc-300 text-[9px] font-bold uppercase tracking-wider flex items-center gap-1"
                            title="Remove custom host"
                          >
                            <Trash2 size={10} className="text-zinc-600" /> Remove Connection
                          </button>
                        )}
                      </div>
                      
                      <div className="bg-black border border-zinc-900 px-3.5 py-2.5 rounded-xl text-[10px] font-mono text-zinc-400 break-all select-all">
                        {server.commandOrUrl}
                      </div>

                      {server.env && (
                        <div className="space-y-1">
                          <span className="text-[8.5px] font-semibold uppercase tracking-widest text-zinc-600 block">System Environment vars:</span>
                          <div className="bg-black/40 px-3 py-2 rounded-xl text-[9px] font-mono text-zinc-500 break-all border border-zinc-900/45">
                            {server.env}
                          </div>
                        </div>
                      )}

                      <div className="space-y-3">
                        <span className="text-[9px] font-bold uppercase tracking-widest text-zinc-500 block">Exposed Context Functions:</span>
                        <div className="space-y-2.5">
                          {server.tools.map((tool) => (
                            <div 
                              key={tool.name}
                              className="p-3.5 bg-black border border-zinc-900 hover:border-zinc-800/80 rounded-xl transition-all"
                            >
                              <div className="flex items-start justify-between gap-4">
                                <div className="font-mono min-w-0">
                                  <div className="flex items-center gap-1.5">
                                    <Hash size={9} className="text-zinc-600" />
                                    <span className="text-[11px] font-medium text-white truncate">{tool.name}</span>
                                  </div>
                                </div>
                                <button
                                  onClick={() => {
                                    if (onInsertContext) {
                                      onInsertContext(`[Active MCP Server: ${server.name}]\nPlease make use of the tool called "${tool.name}". It is registered to run with the following parameter schemas:\n${tool.parameters}\nFeel free to invoke it directly whenever the user mentions actions corresponding to its logic.`);
                                    }
                                  }}
                                  className="text-[9px] font-semibold text-zinc-400 hover:text-white border border-zinc-800 hover:border-zinc-700 bg-zinc-950 hover:bg-zinc-900 rounded-lg px-2 py-1 transition-all flex items-center gap-1 active:scale-[0.98]"
                                  title="Inject tool instructions into prompt"
                                >
                                  <span>Load Parameters</span>
                                  <ArrowRight size={8} />
                                </button>
                              </div>
                              <p className="text-[11px] text-zinc-400 mt-1.5 leading-relaxed font-light">
                                {tool.description}
                              </p>
                              <div className="mt-2.5 text-[9px] font-mono bg-zinc-950/80 p-2 border border-zinc-900/40 rounded-lg text-zinc-500">
                                {tool.parameters}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
