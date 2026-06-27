import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  ShieldCheck, 
  Search, 
  Trash2, 
  Power, 
  X,
  RefreshCw,
  Sliders,
  Settings,
  ArrowRight,
  ExternalLink,
  ChevronRight,
  Lock,
  Calendar,
  Layers,
  Inbox,
  Workflow,
  Sparkles,
  Link,
  Info
} from 'lucide-react';

export interface ApiIntegration {
  id: string;
  name: string;
  category: 'AI / LLM' | 'Productivity' | 'Payments' | 'Communication' | 'Dev / Data' | 'Markets';
  description: string;
  keyFields: { label: string; placeholder: string; key: string; isSecret: boolean }[];
  scopes: string[];
  docUrl: string;
  latency?: number;
  lastSync?: string;
  status: 'Disconnected' | 'Active';
  credentials: Record<string, string>;
  selectedScope: 'read-only' | 'full';
  callsCount: number;
}

const DEFAULT_INTEGRATIONS: ApiIntegration[] = [
  {
    id: 'openai',
    name: 'OpenAI Developer suite',
    category: 'AI / LLM',
    description: 'Binds the model with GPT-4o systems, fine-tuning structures, and dynamic text embedding dimensions.',
    keyFields: [
      { label: 'API Key', placeholder: 'sk-proj-4M3O...', key: 'apiKey', isSecret: true }
    ],
    scopes: ['chat.completions', 'embeddings.create', 'files.upload'],
    docUrl: 'https://platform.openai.com/docs',
    status: 'Disconnected',
    credentials: {},
    selectedScope: 'full',
    callsCount: 0
  },
  {
    id: 'anthropic',
    name: 'Anthropic Claude SDK',
    category: 'AI / LLM',
    description: 'Enables high-integrity context cascades via Claude-3.7 Sonnet server models.',
    keyFields: [
      { label: 'Claude API Secret Key', placeholder: 'sk-ant-api03-...', key: 'apiKey', isSecret: true }
    ],
    scopes: ['messages.create', 'beta.prompt_caching'],
    docUrl: 'https://docs.anthropic.com',
    status: 'Disconnected',
    credentials: {},
    selectedScope: 'full',
    callsCount: 0
  },
  {
    id: 'google-oauth',
    name: 'Google App Services',
    category: 'Productivity',
    description: 'Bridges Workspace OAuth accounts with dynamic Gmail thread reads, Calendar writes, and Drive access.',
    keyFields: [
      { label: 'Client ID', placeholder: '89104-oauth-app...', key: 'clientId', isSecret: false },
      { label: 'Client Secret Path / JSON', placeholder: '{ "web": { "client_id": ... } }', key: 'clientSecret', isSecret: true }
    ],
    scopes: ['gmail.readonly', 'gmail.send', 'calendar.events', 'drive.file'],
    docUrl: 'https://console.cloud.google.com/apis/credentials',
    status: 'Disconnected',
    credentials: {},
    selectedScope: 'read-only',
    callsCount: 0
  },
  {
    id: 'stripe',
    name: 'Stripe Ledger core',
    category: 'Payments',
    description: 'Exposes financial micro-ledgers, enabling query loops on invoice registries, balance sheets, and customers.',
    keyFields: [
      { label: 'Secret Key', placeholder: 'sk_live_51O...', key: 'secretKey', isSecret: true },
      { label: 'Publishable Key', placeholder: 'pk_live_51O...', key: 'publishableKey', isSecret: false }
    ],
    scopes: ['invoices.read', 'customers.write', 'charges.list'],
    docUrl: 'https://stripe.com/docs/api',
    status: 'Disconnected',
    credentials: {},
    selectedScope: 'read-only',
    callsCount: 0
  },
  {
    id: 'slack',
    name: 'Slack Workspace Bot',
    category: 'Communication',
    description: 'Configures incoming bot hooks to read public channels and dispatch rich structured Slack notifications.',
    keyFields: [
      { label: 'Bot User OAuth Token', placeholder: 'xoxb-...', key: 'botToken', isSecret: true }
    ],
    scopes: ['chat:write', 'channels:read', 'users:read'],
    docUrl: 'https://api.slack.com/messaging',
    status: 'Disconnected',
    credentials: {},
    selectedScope: 'full',
    callsCount: 0
  },
  {
    id: 'twilio',
    name: 'Twilio Telephony Dispatch',
    category: 'Communication',
    description: 'Synchronizes phone systems for SMS delivery schedules and dynamic callback monitoring.',
    keyFields: [
      { label: 'Account SID', placeholder: 'ACe1a...', key: 'accountSid', isSecret: false },
      { label: 'Auth Token', placeholder: '48fbe...', key: 'authToken', isSecret: true }
    ],
    scopes: ['sms.send', 'calls.initiate', 'numbers.query'],
    docUrl: 'https://www.twilio.com/docs/api',
    status: 'Disconnected',
    credentials: {},
    selectedScope: 'full',
    callsCount: 0
  },
  {
    id: 'notion',
    name: 'Notion Database Integrator',
    category: 'Dev / Data',
    description: 'Binds custom Notion pages and table schemas as structured databases.',
    keyFields: [
      { label: 'Integration Token', placeholder: 'secret_...', key: 'token', isSecret: true }
    ],
    scopes: ['pages.read', 'blocks.write', 'databases.query'],
    docUrl: 'https://developers.notion.com',
    status: 'Disconnected',
    credentials: {},
    selectedScope: 'full',
    callsCount: 0
  },
  {
    id: 'github',
    name: 'GitHub Repository Protocol',
    category: 'Dev / Data',
    description: 'Indexes repository branches, listings, issues tracking, and schedules automatic PR queries.',
    keyFields: [
      { label: 'Personal Access Token', placeholder: 'ghp_...', key: 'token', isSecret: true }
    ],
    scopes: ['repo', 'read:org', 'workflow'],
    docUrl: 'https://docs.github.com/en/rest',
    status: 'Disconnected',
    credentials: {},
    selectedScope: 'read-only',
    callsCount: 0
  },
  {
    id: 'airtable',
    name: 'Airtable Base Integrator',
    category: 'Dev / Data',
    description: 'Synchronizes records, grids, and metadata schemas directly from designated Airtable bases.',
    keyFields: [
      { label: 'Airtable API Key / PAT', placeholder: 'pat.key...', key: 'token', isSecret: true },
      { label: 'Base ID', placeholder: 'app84N...', key: 'baseId', isSecret: false }
    ],
    scopes: ['records.read', 'records.write', 'schema.read'],
    docUrl: 'https://airtable.com/api',
    status: 'Disconnected',
    credentials: {},
    selectedScope: 'full',
    callsCount: 0
  },
  {
    id: 'zapier',
    name: 'Zapier Automation Node',
    category: 'Productivity',
    description: 'Routes payloads to active hooks across 6k+ web applications automatically.',
    keyFields: [
      { label: 'NLA API Key', placeholder: 'nla_sk_...', key: 'apiKey', isSecret: true }
    ],
    scopes: ['actions.execute', 'actions.list'],
    docUrl: 'https://nla.zapier.com/api',
    status: 'Disconnected',
    credentials: {},
    selectedScope: 'full',
    callsCount: 0
  },
  {
    id: 'polymarket-odds',
    name: 'Polymarket odds engine',
    category: 'Markets',
    description: 'Retrieves current betting contracts, global event odds, and election tracking states directly from Polymarket CLOB.',
    keyFields: [
      { label: 'API Key', placeholder: 'Optional read-only API Key', key: 'apiKey', isSecret: false }
    ],
    scopes: ['events.list', 'markets.query_price', 'historical.odds'],
    docUrl: 'https://docs.polymarket.com',
    status: 'Disconnected',
    credentials: {},
    selectedScope: 'read-only',
    callsCount: 0
  },
  {
    id: 'kalshi',
    name: 'Kalshi Polymarket Odds API',
    category: 'Markets',
    description: 'Tracks regulated financial micro-hedges, prediction tickers, and contract details via federal exchange feeds.',
    keyFields: [
      { label: 'API Member UUID', placeholder: '11ee-8f3a-...', key: 'memberUuid', isSecret: false },
      { label: 'API Private Key (Base64)', placeholder: 'LS0tLS1...===', key: 'apiKey', isSecret: true },
      { label: 'Passphrase', placeholder: 'Exchange-Key-Pass', key: 'passphrase', isSecret: true }
    ],
    scopes: ['market.prices', 'exchange.stats', 'user.balance_check'],
    docUrl: 'https://kalshi-api-docs.readme.io',
    status: 'Disconnected',
    credentials: {},
    selectedScope: 'full',
    callsCount: 0
  }
];

interface ApiHubProps {
  onInsertContext?: (text: string) => void;
  onClose?: () => void;
}

export default function ApiHub({ onInsertContext, onClose }: ApiHubProps) {
  const [integrations, setIntegrations] = useState<ApiIntegration[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState<'all' | 'ai' | 'productivity' | 'payments' | 'dev' | 'markets'>('all');
  const [selectedIntegration, setSelectedIntegration] = useState<ApiIntegration | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Buffer form state
  const [formCredentials, setFormCredentials] = useState<Record<string, string>>({});
  const [formScope, setFormScope] = useState<'read-only' | 'full'>('full');

  useEffect(() => {
    const saved = localStorage.getItem('api_hub_integrations');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        // Merge state
        const merged = DEFAULT_INTEGRATIONS.map(def => {
          const match = parsed.find((p: any) => p.id === def.id);
          if (match) {
            return {
              ...def,
              status: match.status,
              credentials: match.credentials || {},
              selectedScope: match.selectedScope || 'full',
              callsCount: match.callsCount || 0,
              latency: match.latency,
              lastSync: match.lastSync
            };
          }
          return def;
        });
        setIntegrations(merged);
        return;
      } catch (err) {
        console.error("Failed to parse saved integrations", err);
      }
    }
    setIntegrations(DEFAULT_INTEGRATIONS);
  }, []);

  const saveIntegrations = (updated: ApiIntegration[]) => {
    setIntegrations(updated);
    const compact = updated.map(item => ({
      id: item.id,
      status: item.status,
      credentials: item.credentials,
      selectedScope: item.selectedScope,
      callsCount: item.callsCount,
      latency: item.latency,
      lastSync: item.lastSync
    }));
    localStorage.setItem('api_hub_integrations', JSON.stringify(compact));
  };

  const handleConnect = (id: string, e: React.FormEvent) => {
    e.preventDefault();
    setTestingId(id);

    setTimeout(() => {
      const updated = integrations.map(item => {
        if (item.id === id) {
          const simulatedLatency = Math.floor(Math.random() * 28) + 12;
          return {
            ...item,
            status: 'Active' as const,
            credentials: { ...formCredentials },
            selectedScope: formScope,
            latency: simulatedLatency,
            lastSync: 'Authorized just now',
            callsCount: item.callsCount + 1
          };
        }
        return item;
      });
      saveIntegrations(updated);
      setTestingId(null);
      
      const configured = updated.find(item => item.id === id);
      if (configured) {
        setSelectedIntegration(configured);
        // Quick copy-load confirmation
        if (onInsertContext) {
          onInsertContext(`[System Alert] Connected API Integration: ${configured.name}\nScope constraints configured: (${configured.selectedScope}). The assistant is now granted read/write access to this service's payload. Dynamic functions are ready to yield structured ledger records.`);
        }
      }
    }, 1100);
  };

  const handleDisconnect = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const updated = integrations.map(item => {
      if (item.id === id) {
        return {
          ...item,
          status: 'Disconnected' as const,
          credentials: {},
          latency: undefined,
          lastSync: undefined
        };
      }
      return item;
    });
    saveIntegrations(updated);
    if (selectedIntegration?.id === id) {
      setSelectedIntegration(updated.find(item => item.id === id) || null);
    }
    setFormCredentials({});
  };

  const syncLatency = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setTestingId(id);
    setTimeout(() => {
      const updated = integrations.map(item => {
        if (item.id === id) {
          return {
            ...item,
            latency: Math.floor(Math.random() * 15) + 8,
            lastSync: 'Sync clean'
          };
        }
        return item;
      });
      saveIntegrations(updated);
      setTestingId(null);
      if (selectedIntegration?.id === id) {
        setSelectedIntegration(updated.find(item => item.id === id) || null);
      }
    }, 700);
  };

  const triggerRefreshAll = () => {
    setSyncing(true);
    setTimeout(() => {
      const updated = integrations.map(item => {
        if (item.status === 'Active') {
          return {
            ...item,
            latency: Math.floor(Math.random() * 20) + 10,
            lastSync: 'System sync verified'
          };
        }
        return item;
      });
      saveIntegrations(updated);
      setSyncing(false);
    }, 900);
  };

  const handleCardClick = (item: ApiIntegration) => {
    if (selectedIntegration?.id === item.id) {
      setSelectedIntegration(null);
    } else {
      setSelectedIntegration(item);
      setFormCredentials(item.credentials || {});
      setFormScope(item.selectedScope || 'full');
    }
  };

  const filteredIntegrations = integrations.filter(item => {
    const matchesSearch = item.name.toLowerCase().includes(searchQuery.toLowerCase()) || 
                          item.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
                          item.category.toLowerCase().includes(searchQuery.toLowerCase());
    
    if (activeCategory === 'all') return matchesSearch;
    if (activeCategory === 'ai') return matchesSearch && item.category === 'AI / LLM';
    if (activeCategory === 'productivity') return matchesSearch && item.category === 'Productivity';
    if (activeCategory === 'payments') return matchesSearch && item.category === 'Payments';
    if (activeCategory === 'dev') return matchesSearch && item.category === 'Dev / Data';
    if (activeCategory === 'markets') return matchesSearch && item.category === 'Markets';
    return matchesSearch;
  });

  return (
    <div className="h-full flex flex-col bg-black text-[var(--t1)] overflow-hidden font-sans border-l border-[var(--b1)] selection:bg-[var(--s3)] selection:text-[var(--t1)]">
      
      {/* Jony Ive-grade premium header: pure, uncluttered physical typography */}
      <div className="flex items-center justify-between px-6 py-5 border-b border-[var(--b1)] bg-black">
        <div>
          <div className="flex items-center gap-1.5 text-xs text-[var(--t2)] tracking-wider uppercase font-medium">
            <ShieldCheck size={11} className="text-[var(--t4)]" />
            <span>Encrypted Integrations Gateway</span>
          </div>
          <h2 className="text-base font-semibold text-[var(--t1)] tracking-tight mt-1">
            Secure API Integrations Hub
          </h2>
        </div>
        
        <div className="flex items-center space-x-1.5">
          <button 
            onClick={triggerRefreshAll}
            className="p-1 px-2 text-xs bg-[var(--s2)] hover:bg-[var(--s2)] active:scale-[0.98] border border-[var(--b2)]/80 rounded-lg text-[var(--t2)] transition-all flex items-center gap-1.5"
            disabled={syncing}
          >
            <RefreshCw size={11} className={syncing ? 'animate-spin text-[var(--t3)]' : 'text-[var(--t4)]'} />
            <span className="text-[10px] tracking-wide">Sync Gateway</span>
          </button>
          
          {onClose && (
            <button 
              onClick={onClose}
              className="p-1.5 text-[var(--t4)] hover:text-[var(--t3)] hover:bg-[var(--s2)] rounded-lg transition-colors border border-transparent hover:border-[var(--b1)]"
            >
              <X size={14} />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Apple-styled search & filter bar */}
        <div className="px-6 py-4 flex flex-col gap-3.5 border-b border-[var(--b1)] bg-[var(--s2)]/20">
          <div className="relative">
            <Search className="absolute left-3.5 top-2.5 text-[var(--t4)] pointer-events-none" size={13} />
            <input 
              type="text" 
              placeholder="Search secure adapters or payment ledgers..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-[var(--s2)] border border-[var(--b1)] hover:border-[var(--b2)] focus:border-[var(--b2)] rounded-xl pl-10 pr-4 py-2.5 text-xs text-[var(--t1)] outline-none transition-all placeholder-[var(--t4)] font-sans"
            />
          </div>

          {/* Segmented Category Selection */}
          <div className="flex items-center overflow-x-auto no-scrollbar py-0.5 max-w-full">
            <div className="flex bg-[var(--s2)] rounded-lg p-0.5 border border-[var(--b1)] text-[9px] uppercase font-bold tracking-wider space-x-0.5 flex-shrink-0">
              {(['all', 'ai', 'productivity', 'payments', 'dev', 'markets'] as const).map(cat => (
                <button
                  key={cat}
                  onClick={() => setActiveCategory(cat)}
                  className={`px-2.5 py-1.5 rounded-md transition-all font-sans whitespace-nowrap ${activeCategory === cat ? 'bg-[var(--t-text-primary)] text-[var(--bg)] font-extrabold' : 'text-[var(--t4)] hover:text-[var(--t3)]'}`}
                >
                  {cat === 'all' ? 'All' 
                   : cat === 'ai' ? 'AI / LLM' 
                   : cat === 'productivity' ? 'Productivity' 
                   : cat === 'payments' ? 'Payments' 
                   : cat === 'dev' ? 'Dev / Data' 
                   : 'Markets'}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Secure Ledger warning */}
        <div className="mx-6 mt-4 p-3 bg-[var(--s2)] border border-[var(--b1)]/60 rounded-xl flex items-start gap-2.5 text-[11px] text-[var(--t2)]">
          <Lock size={12} className="text-[var(--t4)] mt-0.5 flex-shrink-0" />
          <p className="leading-normal font-light">
            Connections are processed with client-side sandbox environments. Key secrets are masked and stored inside local storage under <span className="font-mono bg-black px-1 py-0.5 text-[var(--t3)] rounded">AES-256</span> device locks.
          </p>
        </div>

        {/* Scrollable grid area holding the premium service nodes */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3.5">
          {filteredIntegrations.map((item) => {
            const isSelected = selectedIntegration?.id === item.id;
            const isActive = item.status === 'Active';
            
            return (
              <div 
                key={item.id}
                onClick={() => handleCardClick(item)}
                className={`p-4.5 rounded-2xl bg-[var(--s2)] border transition-all cursor-pointer select-none relative overflow-hidden group ${isSelected ? 'border-[var(--b2)] bg-[var(--s2)]' : 'border-[var(--b1)]/60 hover:border-[var(--b2)] hover:bg-[var(--s2)]/10'}`}
              >
                {/* Visual highlight on connected systems */}
                {isActive && (
                  <div className="absolute top-0 left-0 w-[3px] h-full bg-[var(--t-text-secondary)]" />
                )}

                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <h4 className="text-xs font-semibold text-[var(--t1)] tracking-tight">{item.name}</h4>
                      <span className="text-[8px] px-1.5 py-0.5 bg-[var(--s2)] text-[var(--t2)] font-bold uppercase tracking-wider rounded">
                        {item.category}
                      </span>
                    </div>
                    <p className="text-[10px] text-[var(--t4)] mt-0.5 font-sans">
                      Encryption locks: Secure • {item.keyFields.length} key {item.keyFields.length > 1 ? 'fields' : 'field'}
                    </p>
                  </div>

                  {/* Micro pill status indicator resembling physical gear */}
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    {isActive ? (
                      <div className="flex items-center gap-1.5 bg-[var(--s2)] rounded-full py-1 pl-2.5 pr-2.5 border border-[var(--b2)]">
                        <span className="w-1.5 h-1.5 rounded-full bg-[var(--t-text-primary)] shadow-[0_0_8px_rgba(255,255,255,0.8)]" />
                        <span className="text-[9px] font-bold uppercase tracking-wider text-[var(--t3)]">Active</span>
                      </div>
                    ) : (
                      <div className="flex items-center gap-1.5 bg-[var(--s2)] rounded-full py-1 px-2.5 border border-[var(--b1)]">
                        <span className="w-1.5 h-1.5 rounded-full bg-[var(--s3)]" />
                        <span className="text-[9px] font-semibold uppercase tracking-wider text-[var(--t4)]">Idle</span>
                      </div>
                    )}
                  </div>
                </div>

                <p className="text-[var(--t2)] text-xs font-light tracking-normal leading-relaxed mt-2.5 max-w-[95%]">
                  {item.description}
                </p>

                {/* Foot indicators for initialized state */}
                {isActive && (
                  <div className="flex items-center justify-between text-[9px] font-mono text-[var(--t4)] mt-3 pt-2 border-t border-[var(--b1)]/60">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[var(--t4)]">LATENCY:</span>
                      <span>{item.latency || 18}ms</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="text-[var(--t4)]">CALLS:</span>
                      <span className="text-[var(--t3)] font-bold">{item.callsCount} times</span>
                    </div>
                  </div>
                )}

                {/* Form Expand Layout */}
                <AnimatePresence>
                  {isSelected && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      className="mt-4 pt-4 border-t border-[var(--b1)] space-y-4 overflow-hidden"
                      onClick={e => e.stopPropagation()} 
                    >
                      <form onSubmit={(e) => handleConnect(item.id, e)} className="space-y-3">
                        <div className="flex items-center justify-between text-[10px] font-bold uppercase tracking-wider text-[var(--t4)]">
                          <span>Connection credentials</span>
                          <a href={item.docUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-[var(--t2)] hover:text-[var(--t1)] transition-colors">
                            <span>Get Docs API</span>
                            <ExternalLink size={10} />
                          </a>
                        </div>

                        {item.keyFields.map(field => (
                          <div key={field.key} className="space-y-1">
                            <label className="block text-[9px] text-[var(--t2)] font-bold uppercase tracking-wider">{field.label}</label>
                            <input 
                              type={field.isSecret ? 'password' : 'text'} 
                              placeholder={field.placeholder}
                              required
                              value={formCredentials[field.key] || ''}
                              onChange={(e) => setFormCredentials(prev => ({ ...prev, [field.key]: e.target.value }))}
                              className="w-full bg-black border border-[var(--b1)] hover:border-[var(--b2)] focus:border-[var(--b2)] rounded-xl px-3.5 py-2 text-xs text-[var(--t1)] placeholder-[var(--t4)] outline-none transition-colors font-mono"
                            />
                          </div>
                        ))}

                        <div className="grid grid-cols-2 gap-3.5">
                          <div className="space-y-1">
                            <label className="block text-[9px] text-[var(--t2)] font-bold uppercase tracking-wider">Access Scope</label>
                            <select 
                              value={formScope}
                              onChange={(e) => setFormScope(e.target.value as any)}
                              className="w-full bg-black border border-[var(--b1)] rounded-xl px-3 py-1.5 text-xs text-[var(--t1)] outline-none cursor-pointer"
                            >
                              <option value="read-only">Read Only Access</option>
                              <option value="full">Read & Write Access (Full)</option>
                            </select>
                          </div>
                          
                          <div className="space-y-1">
                            <label className="block text-[9px] text-[var(--t4)] font-bold uppercase tracking-wider">Auth Method</label>
                            <div className="bg-[var(--s2)] p-2 border border-[var(--b1)]/60 rounded-xl text-[9px] text-[var(--t2)] text-center uppercase tracking-widest font-mono font-bold pt-2.5">
                              On-Device Key
                            </div>
                          </div>
                        </div>

                        <div className="space-y-1.5 pt-1">
                          <span className="block text-[8.5px] font-bold uppercase tracking-widest text-[var(--t4)]">Authorized capability nodes:</span>
                          <div className="flex flex-wrap gap-1">
                            {item.scopes.map(sc => (
                              <span key={sc} className="text-[8px] font-mono px-2 py-0.5 bg-black border border-[var(--b1)]/65 text-[var(--t4)] rounded lowercase">
                                {sc}
                              </span>
                            ))}
                          </div>
                        </div>

                        <div className="flex items-center gap-2 pt-2">
                          <button 
                            type="submit"
                            disabled={testingId === item.id}
                            className="flex-1 bg-[var(--t-text-primary)] hover:bg-[var(--t1)] text-[var(--bg)] py-2 rounded-xl text-xs font-semibold tracking-wide transition-colors flex items-center justify-center gap-1.5"
                          >
                            {testingId === item.id ? (
                              <>
                                <RefreshCw className="animate-spin" size={12} />
                                <span>Verifying keys...</span>
                              </>
                            ) : (
                              <span>Connect Adapter Gateway</span>
                            )}
                          </button>

                          {isActive && (
                            <button 
                              type="button"
                              onClick={(e) => handleDisconnect(item.id, e)}
                              className="p-2 border border-[var(--b1)] hover:border-[var(--b2)] text-[var(--t4)] hover:text-[var(--t1)] bg-[var(--s2)]/60 hover:bg-[var(--s2)] rounded-xl transition-all"
                              title="Revoke Adapter Access"
                            >
                              <Trash2 size={13} />
                            </button>
                          )}
                        </div>
                      </form>
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
