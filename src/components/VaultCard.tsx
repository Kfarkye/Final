import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Lock, Unlock, CheckCircle2, ChevronRight, KeyRound, Loader2 } from 'lucide-react';
import { ApiIntegration } from './CredentialVault';

interface VaultCardProps {
  integration: ApiIntegration;
  isAuthorized: boolean;
  isSyncing?: boolean;
  onConnect: (id: string, keyValues: Record<string, string>) => Promise<void>;
}

const VaultCard: React.FC<VaultCardProps> = ({ integration, isAuthorized, isSyncing, onConnect }) => {
  const [expanded, setExpanded] = useState(false);
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await onConnect(integration.id, credentials);
      setExpanded(false);
    } catch (err: any) {
      setError(err.message || 'Failed to authorize keys.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleClick = () => {
    if (!isAuthorized) {
      setExpanded(!expanded);
    }
  };

  return (
    <motion.div
      layout
      onClick={handleClick}
      className={`relative overflow-hidden rounded-2xl border transition-all duration-300 ${
        isAuthorized 
          ? 'bg-zinc-950/80 border-emerald-900/30 shadow-[0_0_15px_rgba(16,185,129,0.05)]' 
          : expanded 
            ? 'bg-zinc-900/40 border-zinc-700/50 cursor-default' 
            : 'bg-black border-zinc-800/60 hover:bg-zinc-900/30 hover:border-zinc-700 cursor-pointer'
      }`}
    >
      {/* Background glow for authorized state */}
      <AnimatePresence>
        {isAuthorized && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute -inset-1 bg-gradient-to-r from-emerald-500/10 to-transparent blur-xl pointer-events-none"
          />
        )}
      </AnimatePresence>

      <div className="relative p-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className={`p-2.5 rounded-xl border ${isAuthorized ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400' : 'bg-zinc-900 border-zinc-800 text-zinc-400'}`}>
              <KeyRound size={20} strokeWidth={1.5} />
            </div>
            <div>
              <h3 className="text-sm font-medium text-white tracking-tight flex items-center gap-2">
                {integration.name}
                {isAuthorized && (
                  <motion.span
                    initial={{ scale: 0, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    className="flex h-2 w-2 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.8)]"
                  />
                )}
              </h3>
              <p className="text-xs text-zinc-500 mt-0.5 line-clamp-1">{integration.description}</p>
            </div>
          </div>

          <div className="flex items-center">
            {isSyncing ? (
              <Loader2 size={16} className="text-zinc-600 animate-spin" />
            ) : isAuthorized ? (
              <div className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/20">
                <CheckCircle2 size={12} className="text-emerald-400" />
                <span className="text-[10px] uppercase tracking-wider font-semibold text-emerald-400">Vaulted</span>
              </div>
            ) : (
              <ChevronRight size={18} className={`text-zinc-600 transition-transform duration-300 ${expanded ? 'rotate-90' : ''}`} />
            )}
          </div>
        </div>

        <AnimatePresence>
          {expanded && !isAuthorized && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
              className="overflow-hidden"
            >
              <div className="pt-6 pb-2">
                <div className="p-4 rounded-xl bg-black border border-zinc-800/80 mb-5 relative overflow-hidden">
                  <div className="absolute top-0 right-0 p-2 opacity-20 pointer-events-none">
                    <Lock size={64} strokeWidth={1} />
                  </div>
                  <h4 className="text-xs font-semibold text-zinc-300 uppercase tracking-widest mb-1 relative z-10 flex items-center gap-1.5">
                    <Lock size={12} /> Secure Key Provisioning
                  </h4>
                  <p className="text-[11px] text-zinc-500 leading-relaxed relative z-10">
                    Keys are never stored in your browser. They are encrypted end-to-end and vaulted directly into Google Cloud Secret Manager.
                  </p>
                </div>

                <form onSubmit={handleSubmit} className="space-y-4" onClick={(e) => e.stopPropagation()}>
                  {integration.keyFields.map((field) => (
                    <div key={field.key} className="space-y-1.5">
                      <label className="block text-[10px] font-bold uppercase tracking-wider text-zinc-400 ml-1">
                        {field.label}
                      </label>
                      <div className="relative">
                        <input
                          type={field.isSecret ? "password" : "text"}
                          required
                          placeholder={field.placeholder}
                          value={credentials[field.key] || ''}
                          onChange={(e) => setCredentials({ ...credentials, [field.key]: e.target.value })}
                          className={`w-full bg-zinc-950/50 border border-zinc-800 rounded-xl px-4 py-3 text-sm text-white placeholder-zinc-700 outline-none transition-all font-mono focus:border-indigo-500/50 focus:ring-1 focus:ring-indigo-500/50 ${
                            field.isSecret && credentials[field.key]?.length > 0 ? 'tracking-[0.25em]' : ''
                          }`}
                        />
                        {field.isSecret && (
                          <div className="absolute right-3 top-1/2 -translate-y-1/2 p-1.5 rounded-lg bg-zinc-900 border border-zinc-800">
                            <Unlock size={12} className="text-zinc-500" />
                          </div>
                        )}
                      </div>
                    </div>
                  ))}

                  {error && (
                    <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-xs">
                      {error}
                    </div>
                  )}

                  <div className="pt-2 flex items-center gap-3">
                    <button
                      type="submit"
                      disabled={submitting}
                      className="flex-1 bg-white text-black py-2.5 rounded-xl text-sm font-semibold tracking-wide transition-all hover:bg-zinc-200 active:scale-[0.98] disabled:opacity-50 disabled:active:scale-100 flex items-center justify-center gap-2"
                    >
                      {submitting ? (
                        <>
                          <Loader2 size={16} className="animate-spin" />
                          <span>Vaulting Key...</span>
                        </>
                      ) : (
                        <span>Authorize & Vault Key</span>
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => setExpanded(false)}
                      className="px-4 py-2.5 rounded-xl text-sm font-medium text-zinc-400 hover:text-white transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  );
};

export default VaultCard;
