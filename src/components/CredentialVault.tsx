import React, { useState, useEffect } from 'react';
import { ShieldCheck, Search, X, Lock, RefreshCw } from 'lucide-react';
import VaultCard from './VaultCard';

export interface ApiIntegration {
  id: string;
  name: string;
  category: 'AI / LLM' | 'Productivity' | 'Payments' | 'Communication' | 'Dev / Data' | 'Markets';
  description: string;
  keyFields: { label: string; placeholder: string; key: string; isSecret: boolean }[];
  docUrl: string;
}

const INTEGRATIONS: ApiIntegration[] = [
  {
    id: 'OPENAI_API_KEY', // Matching common ENV variable names for backend usage
    name: 'OpenAI Developer suite',
    category: 'AI / LLM',
    description: 'Binds the model with GPT-4o systems, fine-tuning structures, and dynamic text embedding dimensions.',
    keyFields: [{ label: 'API Key', placeholder: 'sk-proj-4M3O...', key: 'apiKey', isSecret: true }],
    docUrl: 'https://platform.openai.com/docs'
  },
  {
    id: 'ANTHROPIC_API_KEY',
    name: 'Anthropic Claude SDK',
    category: 'AI / LLM',
    description: 'Enables high-integrity context cascades via Claude-3.7 Sonnet server models.',
    keyFields: [{ label: 'Claude API Secret Key', placeholder: 'sk-ant-api03-...', key: 'apiKey', isSecret: true }],
    docUrl: 'https://docs.anthropic.com'
  },
  {
    id: 'GITHUB_PAT',
    name: 'GitHub Repository Protocol',
    category: 'Dev / Data',
    description: 'Indexes repository branches, listings, issues tracking, and schedules automatic PR queries.',
    keyFields: [{ label: 'Personal Access Token', placeholder: 'ghp_...', key: 'apiKey', isSecret: true }],
    docUrl: 'https://docs.github.com/en/rest'
  },
  {
    id: 'STRIPE_SECRET_KEY',
    name: 'Stripe Ledger core',
    category: 'Payments',
    description: 'Exposes financial micro-ledgers, enabling query loops on invoice registries, balance sheets, and customers.',
    keyFields: [{ label: 'Secret Key', placeholder: 'sk_live_51O...', key: 'apiKey', isSecret: true }],
    docUrl: 'https://stripe.com/docs/api'
  },
  {
    id: 'POLYMARKET_API_KEY',
    name: 'Polymarket odds engine',
    category: 'Markets',
    description: 'Retrieves current betting contracts, global event odds, and election tracking states directly from Polymarket CLOB.',
    keyFields: [{ label: 'API Key', placeholder: 'Optional read-only API Key', key: 'apiKey', isSecret: true }],
    docUrl: 'https://docs.polymarket.com'
  }
];

interface CredentialVaultProps {
  onClose?: () => void;
  tenantId?: string; // Passed down from auth
}

export default function CredentialVault({ onClose, tenantId = 'default' }: CredentialVaultProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState<'all' | 'ai' | 'productivity' | 'payments' | 'dev' | 'markets'>('all');
  const [statuses, setStatuses] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);

  const fetchStatuses = async () => {
    setLoading(true);
    try {
      const keys = INTEGRATIONS.map(i => i.id).join(',');
      const res = await fetch(`/api/vault/status?keys=${keys}`, {
        headers: { 'x-tenant-id': tenantId }
      });
      if (res.ok) {
        const data = await res.json();
        setStatuses(data.statuses || {});
      }
    } catch (err) {
      console.error('Failed to fetch vault status', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStatuses();
  }, [tenantId]);

  const handleConnect = async (id: string, credentials: Record<string, string>) => {
    // Assuming single key for MVP BYOK. For multiple, we might loop.
    const primaryKey = credentials['apiKey'];
    if (!primaryKey) throw new Error("No API key provided");

    const res = await fetch('/api/vault/set', {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'x-tenant-id': tenantId
      },
      body: JSON.stringify({ key: id, value: primaryKey })
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Failed to save secret');
    }

    // Update local status optimistically
    setStatuses(prev => ({ ...prev, [id]: true }));
  };

  const filteredIntegrations = INTEGRATIONS.filter(item => {
    const matchesSearch = item.name.toLowerCase().includes(searchQuery.toLowerCase()) || 
                          item.description.toLowerCase().includes(searchQuery.toLowerCase());
    
    if (activeCategory === 'all') return matchesSearch;
    if (activeCategory === 'ai') return matchesSearch && item.category === 'AI / LLM';
    if (activeCategory === 'productivity') return matchesSearch && item.category === 'Productivity';
    if (activeCategory === 'payments') return matchesSearch && item.category === 'Payments';
    if (activeCategory === 'dev') return matchesSearch && item.category === 'Dev / Data';
    if (activeCategory === 'markets') return matchesSearch && item.category === 'Markets';
    return matchesSearch;
  });

  return (
    <div className="h-full flex flex-col bg-black text-zinc-100 overflow-hidden font-sans border-l border-zinc-900 selection:bg-indigo-500/30 selection:text-white">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-5 border-b border-zinc-900 bg-black">
        <div>
          <div className="flex items-center gap-1.5 text-xs text-indigo-400 tracking-wider uppercase font-bold">
            <ShieldCheck size={12} />
            <span>Identity Passport</span>
          </div>
          <h2 className="text-xl font-semibold text-white tracking-tight mt-1">
            Credential Vault
          </h2>
        </div>
        
        <div className="flex items-center space-x-2">
          <button 
            onClick={fetchStatuses}
            className="p-2 bg-zinc-950 hover:bg-zinc-900 active:scale-[0.98] border border-zinc-800 rounded-xl text-zinc-400 transition-all flex items-center gap-1.5"
            disabled={loading}
          >
            <RefreshCw size={14} className={loading ? 'animate-spin text-zinc-300' : 'text-zinc-500'} />
            <span className="text-xs font-medium tracking-wide">Sync Vault</span>
          </button>
          
          {onClose && (
            <button 
              onClick={onClose}
              className="p-2 text-zinc-500 hover:text-white hover:bg-zinc-900 rounded-xl transition-colors border border-transparent"
            >
              <X size={16} />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Search & Filter */}
        <div className="px-6 py-5 flex flex-col gap-4 border-b border-zinc-900 bg-zinc-950/20">
          <div className="relative">
            <Search className="absolute left-3.5 top-3 text-zinc-500 pointer-events-none" size={15} />
            <input 
              type="text" 
              placeholder="Search providers (e.g. OpenAI, Stripe)..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-black border border-zinc-800 hover:border-zinc-700 focus:border-indigo-500/50 rounded-xl pl-11 pr-4 py-3 text-sm text-white outline-none transition-all placeholder-zinc-600 focus:ring-1 focus:ring-indigo-500/50"
            />
          </div>

          <div className="flex items-center overflow-x-auto no-scrollbar py-0.5 max-w-full">
            <div className="flex bg-black rounded-xl p-1 border border-zinc-800 text-[10px] uppercase font-bold tracking-wider space-x-1 flex-shrink-0">
              {(['all', 'ai', 'productivity', 'payments', 'dev', 'markets'] as const).map(cat => (
                <button
                  key={cat}
                  onClick={() => setActiveCategory(cat)}
                  className={`px-3 py-2 rounded-lg transition-all font-sans whitespace-nowrap ${activeCategory === cat ? 'bg-zinc-200 text-black shadow-sm' : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-900'}`}
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

        {/* Security Notice */}
        <div className="mx-6 mt-5 p-3.5 bg-indigo-500/5 border border-indigo-500/10 rounded-xl flex items-start gap-3 text-xs text-indigo-200/70">
          <Lock size={14} className="text-indigo-400 mt-0.5 flex-shrink-0" />
          <p className="leading-relaxed font-light">
            Your keys never touch your browser's local storage. They are brokered via a secure encrypted tunnel directly to <strong className="font-semibold text-indigo-300">Google Cloud Secret Manager</strong>.
          </p>
        </div>

        {/* List of Integrations */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
          {filteredIntegrations.map((item) => (
            <VaultCard
              key={item.id}
              integration={item}
              isAuthorized={statuses[item.id] || false}
              isSyncing={loading}
              onConnect={handleConnect}
            />
          ))}
          {filteredIntegrations.length === 0 && (
            <div className="text-center py-10 text-zinc-600 text-sm">
              No integrations found matching your search.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
