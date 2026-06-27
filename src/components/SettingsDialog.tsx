import React, { useState } from 'react';
import { motion } from 'motion/react';
import { X, Settings, Shield, User as UserIcon } from 'lucide-react';
import { doc, setDoc } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { logAuditAction } from '../lib/audit';

interface SettingsDialogProps {
  onClose: () => void;
  currentUser: any;
  onUpdateRole: (role: string) => void;
  modelConfigs: {
    gemini: string;
    chatgpt: string;
    claude: string;
    grok: string;
    deepseek: string;
    codex: string;
  };
  onUpdateModelConfigs: (configs: {
    gemini: string;
    chatgpt: string;
    claude: string;
    grok: string;
    deepseek: string;
    codex: string;
  }) => void;
}

export default function SettingsDialog({
  onClose,
  currentUser,
  onUpdateRole,
  modelConfigs,
  onUpdateModelConfigs
}: SettingsDialogProps) {
  const [loading, setLoading] = useState(false);
  const [selectedRole, setSelectedRole] = useState(currentUser?.role || 'Viewer');
  const [configs, setConfigs] = useState(modelConfigs);

  // Custom input toggles or inputs
  const [geminiCustom, setGeminiCustom] = useState(!['gemini-3.5-flash', 'gemini-3.5-flash-puppeteer', 'gemini-3.1-pro-preview', 'gemini-3.1-pro-preview-next', 'gemini-3.1-pre-preview', 'gemini-3.1-flash-lite', 'gemini-flash-latest', 'gemini-2.5-flash-image', 'gemini-3.1-flash-image', 'gemini-3-pro-image', 'gemini-3.1-flash-live-preview', 'gemini-3.5-live-translate-preview', 'gemini-3.1-flash-tts-preview'].includes(modelConfigs.gemini));
  const [chatgptCustom, setChatgptCustom] = useState(!['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-nano'].includes(modelConfigs.chatgpt));
  const [claudeCustom, setClaudeCustom] = useState(!['claude-opus-4-8', 'claude-opus-4-6', 'claude-sonnet-4-6'].includes(modelConfigs.claude));
  const [grokCustom, setGrokCustom] = useState(!['grok-4.3', 'grok-4.20-reasoning', 'grok-4.20-non-reasoning', 'grok-4.1-fast-reasoning'].includes(modelConfigs.grok));
  const [deepseekCustom, setDeepseekCustom] = useState(!['deepseek-v3.2-maas', 'deepseek-r1-0528-maas', 'deepseek-v3.1-maas', 'deepseek-ocr-maas'].includes(modelConfigs.deepseek));
  const [codexCustom, setCodexCustom] = useState(!['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini'].includes(modelConfigs.codex || 'gpt-5.5'));

  const handleSave = async () => {
    if (!currentUser) return;
    setLoading(true);
    try {
      // Save user config in Firestore
      const userRef = doc(db, 'users', currentUser.uid);
      const updates: any = {};

      if (selectedRole !== currentUser.role) {
        updates.role = selectedRole;
        logAuditAction(currentUser, 'UPDATE_ROLE', { newRole: selectedRole, previousRole: currentUser.role });
        onUpdateRole(selectedRole);
      }

      updates.modelConfigs = configs;
      logAuditAction(currentUser, 'UPDATE_MODEL_CONFIGS', configs);

      await setDoc(userRef, updates, { merge: true });
      onUpdateModelConfigs(configs);
      onClose();
    } catch (err) {
      console.error('Failed to update settings:', err);
      alert('Failed to update settings');
    } finally {
      setLoading(false);
    }
  };

  const handleModelChange = (key: 'gemini' | 'chatgpt' | 'claude' | 'grok' | 'deepseek' | 'codex', val: string) => {
    setConfigs(prev => ({ ...prev, [key]: val }));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[var(--bg)]/80 backdrop-blur-sm">
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        className="bg-[var(--s2)] border border-[var(--b1)] rounded-2xl w-full max-w-lg overflow-hidden shadow-2xl flex flex-col"
      >
        <div className="p-6 border-b border-[var(--b1)] flex justify-between items-center bg-black">
          <h2 className="text-lg font-medium text-[var(--t1)] flex items-center gap-2 tracking-tight">
            <Settings size={18} className="text-[var(--t2)]" /> Settings
          </h2>
          <button onClick={onClose} className="text-[var(--t4)] hover:text-[var(--t1)] transition-colors">
            <X size={20} />
          </button>
        </div>

        <div className="p-6 bg-[var(--s2)]/50 space-y-8 overflow-y-auto max-h-[60vh] custom-scrollbar">
          <div className="space-y-4">
            <div className="flex items-center gap-3 border-b border-[var(--b1)] pb-4">
              <div className="w-12 h-12 rounded-full bg-[var(--s3)] flex items-center justify-center overflow-hidden border border-[var(--b1)]">
                {currentUser?.photoURL ? (
                  <img src={currentUser.photoURL} alt="Profile" className="w-full h-full object-cover" />
                ) : (
                  <UserIcon size={24} className="text-[var(--t4)]" />
                )}
              </div>
              <div>
                <p className="text-sm font-medium text-[var(--t1)]">{currentUser?.displayName || 'User'}</p>
                <p className="text-xs text-[var(--t4)]">{currentUser?.email}</p>
              </div>
            </div>
          </div>

          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <Shield size={16} className="text-indigo-400" />
              <h3 className="text-sm font-semibold uppercase tracking-widest text-[var(--t2)]">Enterprise Role Simulation</h3>
            </div>
            <p className="text-xs text-[var(--t4)] font-light leading-relaxed">
              Select your simulated role. Depending on your role, different privileges are granted (e.g., Admins can view Audit Logs; Viewers are restricted to read-only views).
            </p>
            <div className="flex gap-4">
              {['Admin', 'Editor', 'Viewer'].map((r) => (
                <button
                  key={r}
                  onClick={() => setSelectedRole(r)}
                  className={`flex-1 py-3 text-sm rounded-xl transition-all border ${selectedRole === r
                      ? 'bg-indigo-500/10 text-indigo-300 border-indigo-500/30 font-medium'
                      : 'bg-black border-[var(--b1)] text-[var(--t2)] hover:bg-[var(--s1)] hover:border-[var(--b2)]'
                    }`}
                >
                  {r}
                </button>
              ))}
            </div>
          </div>

          {/* Model Customization */}
          <div className="space-y-6 pt-6 border-t border-[var(--b1)]">
            <div className="flex items-center gap-2">
              <Settings size={16} className="text-emerald-400" />
              <h3 className="text-sm font-semibold uppercase tracking-widest text-[var(--t2)]">LLM Model Customizers</h3>
            </div>

            {/* Gemini */}
            <div className="space-y-2">
              <div className="flex justify-between items-center text-xs">
                <span className="font-semibold text-[var(--t2)]">Gemini model</span>
                <button
                  onClick={() => setGeminiCustom(!geminiCustom)}
                  className="text-[var(--t4)] hover:text-[var(--t1)] transition-colors"
                >
                  {geminiCustom ? "Select preset" : "Set custom model ID"}
                </button>
              </div>
              {geminiCustom ? (
                <input
                  type="text"
                  value={configs.gemini}
                  onChange={(e) => handleModelChange('gemini', e.target.value)}
                  className="w-full bg-[var(--s2)] border border-[var(--b1)] rounded-xl px-4 py-2.5 text-sm font-mono text-[var(--t3)] focus:border-[var(--b2)]"
                  placeholder="e.g. gemini-3.5-flash"
                />
              ) : (
                <select
                  value={configs.gemini}
                  onChange={(e) => handleModelChange('gemini', e.target.value)}
                  className="w-full bg-black border border-[var(--b1)] rounded-xl px-4 py-2.5 text-sm text-[var(--t3)] focus:border-[var(--b2)]"
                >
                  <option value="gemini-3.5-flash">Gemini 3.5 Flash (Standard)</option>
                  <option value="gemini-3.5-flash-puppeteer">Gemini 3.5 Flash (Puppeteer)</option>
                  <option value="gemini-3.1-pre-preview">Gemini 3.1 Pre-Preview (Deep Think)</option>
                  <option value="gemini-3.1-pro-preview">Gemini 3.1 Pro (Reasoning)</option>
                  <option value="gemini-3.1-pro-preview-next">Gemini 3.1 Pro Preview Next (Deep Think)</option>
                  <option value="gemini-3.1-flash-lite">Gemini 3.1 Flash Lite</option>
                  <option value="gemini-flash-latest">Gemini Flash Latest</option>
                  <option value="gemini-2.5-flash-image">Gemini 2.5 Flash (Image)</option>
                  <option value="gemini-3.1-flash-image">Gemini 3.1 Flash (Image)</option>
                  <option value="gemini-3-pro-image">Gemini 3 Pro (Image)</option>
                  <option value="gemini-3.1-flash-live-preview">Gemini 3.1 Flash (Live)</option>
                  <option value="gemini-3.5-live-translate-preview">Gemini 3.5 Live Translate</option>
                  <option value="gemini-3.1-flash-tts-preview">Gemini 3.1 Flash TTS</option>
                </select>
              )}
            </div>

            {/* ChatGPT */}
            <div className="space-y-2">
              <div className="flex justify-between items-center text-xs">
                <span className="font-semibold text-[var(--t2)]">ChatGPT model</span>
                <button
                  onClick={() => setChatgptCustom(!chatgptCustom)}
                  className="text-[var(--t4)] hover:text-[var(--t1)] transition-colors"
                >
                  {chatgptCustom ? "Select preset" : "Set custom model ID"}
                </button>
              </div>
              {chatgptCustom ? (
                <input
                  type="text"
                  value={configs.chatgpt}
                  onChange={(e) => handleModelChange('chatgpt', e.target.value)}
                  className="w-full bg-[var(--s2)] border border-[var(--b1)] rounded-xl px-4 py-2.5 text-sm font-mono text-[var(--t3)] focus:border-[var(--b2)]"
                  placeholder="e.g. gpt-4o"
                />
              ) : (
                <select
                  value={configs.chatgpt}
                  onChange={(e) => handleModelChange('chatgpt', e.target.value)}
                  className="w-full bg-black border border-[var(--b1)] rounded-xl px-4 py-2.5 text-sm text-[var(--t3)] focus:border-[var(--b2)]"
                >
                  <option value="gpt-5.5">GPT-5.5 (Flagship)</option>
                  <option value="gpt-5.4">GPT-5.4 (Strong)</option>
                  <option value="gpt-5.4-mini">GPT-5.4 Mini (Fast)</option>
                  <option value="gpt-5.4-nano">GPT-5.4 Nano (Cheapest)</option>
                </select>
              )}
            </div>

            {/* Claude */}
            <div className="space-y-2">
              <div className="flex justify-between items-center text-xs">
                <span className="font-semibold text-[var(--t2)]">Claude model</span>
                <button
                  onClick={() => setClaudeCustom(!claudeCustom)}
                  className="text-[var(--t4)] hover:text-[var(--t1)] transition-colors"
                >
                  {claudeCustom ? "Select preset" : "Set custom model ID"}
                </button>
              </div>
              {claudeCustom ? (
                <input
                  type="text"
                  value={configs.claude}
                  onChange={(e) => handleModelChange('claude', e.target.value)}
                  className="w-full bg-[var(--s2)] border border-[var(--b2)] rounded-xl px-4 py-2.5 text-sm font-mono text-[var(--t1)] focus:border-[var(--b2)] shadow-inner"
                  placeholder="e.g. claude-opus-4-8"
                />
              ) : (
                <select
                  value={configs.claude}
                  onChange={(e) => handleModelChange('claude', e.target.value)}
                  className="w-full bg-black border border-[var(--b1)] rounded-xl px-4 py-2.5 text-sm text-[var(--t3)] focus:border-[var(--b2)]"
                >
                  <option value="claude-opus-4-8">Claude Opus 4.8 (First Choice)</option>
                  <option value="claude-opus-4-6">Claude Opus 4.6</option>
                  <option value="claude-sonnet-4-6">Claude Sonnet 4.6 (Fast)</option>
                </select>
              )}
            </div>

            {/* Grok */}
            <div className="space-y-2">
              <div className="flex justify-between items-center text-xs">
                <span className="font-semibold text-[var(--t2)]">Grok model</span>
                <button
                  onClick={() => setGrokCustom(!grokCustom)}
                  className="text-[var(--t4)] hover:text-[var(--t1)] transition-colors"
                >
                  {grokCustom ? "Select preset" : "Set custom model ID"}
                </button>
              </div>
              {grokCustom ? (
                <input
                  type="text"
                  value={configs.grok}
                  onChange={(e) => handleModelChange('grok', e.target.value)}
                  className="w-full bg-[var(--s2)] border border-[var(--b1)] rounded-xl px-4 py-2.5 text-sm font-mono text-[var(--t3)] focus:border-[var(--b2)]"
                  placeholder="e.g. grok-2-latest"
                />
              ) : (
                <select
                  value={configs.grok}
                  onChange={(e) => handleModelChange('grok', e.target.value)}
                  className="w-full bg-black border border-[var(--b1)] rounded-xl px-4 py-2.5 text-sm text-[var(--t3)] focus:border-[var(--b2)]"
                >
                  <option value="grok-4.3">Grok 4.3 (Flagship)</option>
                  <option value="grok-4.20-reasoning">Grok 4.20 Reasoning</option>
                  <option value="grok-4.20-non-reasoning">Grok 4.20 Fast (Agents)</option>
                  <option value="grok-4.1-fast-reasoning">Grok 4.1 Fast Reasoning (Budget)</option>
                </select>
              )}
            </div>

            {/* DeepSeek */}
            <div className="space-y-2">
              <div className="flex justify-between items-center text-xs">
                <span className="font-semibold text-[var(--t2)]">DeepSeek model</span>
                <button
                  onClick={() => setDeepseekCustom(!deepseekCustom)}
                  className="text-[var(--t4)] hover:text-[var(--t1)] transition-colors"
                >
                  {deepseekCustom ? "Select preset" : "Set custom model ID"}
                </button>
              </div>
              {deepseekCustom ? (
                <input
                  type="text"
                  value={configs.deepseek}
                  onChange={(e) => handleModelChange('deepseek', e.target.value)}
                  className="w-full bg-[var(--s2)] border border-[var(--b1)] rounded-xl px-4 py-2.5 text-sm font-mono text-[var(--t3)] focus:border-[var(--b2)]"
                  placeholder="e.g. deepseek-v3.2-maas"
                />
              ) : (
                <select
                  value={configs.deepseek}
                  onChange={(e) => handleModelChange('deepseek', e.target.value)}
                  className="w-full bg-black border border-[var(--b1)] rounded-xl px-4 py-2.5 text-sm text-[var(--t3)] focus:border-[var(--b2)]"
                >
                  <option value="deepseek-v3.2-maas">DeepSeek V3.2 (Flagship)</option>
                  <option value="deepseek-r1-0528-maas">DeepSeek R1 0528 (Reasoning)</option>
                  <option value="deepseek-v3.1-maas">DeepSeek V3.1</option>
                  <option value="deepseek-ocr-maas">DeepSeek OCR</option>
                </select>
              )}
            </div>

            {/* Codex */}
            <div className="space-y-2">
              <div className="flex justify-between items-center text-xs">
                <span className="font-semibold text-[var(--t2)]">Codex model</span>
                <button
                  onClick={() => setCodexCustom(!codexCustom)}
                  className="text-[var(--t4)] hover:text-[var(--t1)] transition-colors"
                >
                  {codexCustom ? "Select preset" : "Set custom model ID"}
                </button>
              </div>
              {codexCustom ? (
                <input
                  type="text"
                  value={configs.codex || 'gpt-5.5'}
                  onChange={(e) => handleModelChange('codex', e.target.value)}
                  className="w-full bg-[var(--s2)] border border-[var(--b1)] rounded-xl px-4 py-2.5 text-sm font-mono text-[var(--t3)] focus:border-[var(--b2)]"
                  placeholder="e.g. gpt-5.5"
                />
              ) : (
                <select
                  value={configs.codex || 'gpt-5.5'}
                  onChange={(e) => handleModelChange('codex', e.target.value)}
                  className="w-full bg-black border border-[var(--b1)] rounded-xl px-4 py-2.5 text-sm text-[var(--t3)] focus:border-[var(--b2)]"
                >
                  <option value="gpt-5.5">GPT-5.5 (Flagship)</option>
                  <option value="gpt-5.4">GPT-5.4 (Strong)</option>
                  <option value="gpt-5.4-mini">GPT-5.4 Mini (Fast)</option>
                </select>
              )}
            </div>
          </div>
        </div>

        <div className="p-6 border-t border-[var(--b1)] bg-black flex justify-end gap-3">
          <button
            onClick={onClose}
            className="px-5 py-2.5 rounded-xl border border-[var(--b1)] text-sm font-medium text-[var(--t3)] hover:bg-[var(--s1)] transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={loading}
            className="px-5 py-2.5 rounded-xl bg-[var(--t1)] text-[var(--bg)] text-sm font-medium hover:bg-[var(--t-text-secondary)] transition-colors disabled:opacity-50"
          >
            {loading ? 'Saving...' : 'Save Settings'}
          </button>
        </div>
      </motion.div>
    </div>
  );
}
