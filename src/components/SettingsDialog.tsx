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
  };
  onUpdateModelConfigs: (configs: {
    gemini: string;
    chatgpt: string;
    claude: string;
    grok: string;
    deepseek: string;
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
  const [geminiCustom, setGeminiCustom] = useState(!['gemini-3.5-flash', 'gemini-3.1-pro-preview', 'gemini-3.1-pro-preview-next', 'gemini-3.1-pre-preview', 'gemini-3.1-flash-lite', 'gemini-flash-latest', 'gemini-2.5-flash-image', 'gemini-3.1-flash-image', 'gemini-3-pro-image', 'gemini-3.1-flash-live-preview', 'gemini-3.5-live-translate-preview', 'gemini-3.1-flash-tts-preview'].includes(modelConfigs.gemini));
  const [chatgptCustom, setChatgptCustom] = useState(!['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-nano'].includes(modelConfigs.chatgpt));
  const [claudeCustom, setClaudeCustom] = useState(!['claude-opus-4-8', 'claude-opus-4-6', 'claude-sonnet-4-6'].includes(modelConfigs.claude));
  const [grokCustom, setGrokCustom] = useState(!['grok-4.3', 'grok-4.20-reasoning', 'grok-4.20-non-reasoning', 'grok-4.1-fast-reasoning', 'grok-build-0.1'].includes(modelConfigs.grok));
  const [deepseekCustom, setDeepseekCustom] = useState(!['deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-r1'].includes(modelConfigs.deepseek));

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

  const handleModelChange = (key: 'gemini' | 'chatgpt' | 'claude' | 'grok' | 'deepseek', val: string) => {
    setConfigs(prev => ({ ...prev, [key]: val }));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
      <motion.div 
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        className="bg-zinc-950 border border-white/10 rounded-2xl w-full max-w-lg overflow-hidden shadow-2xl flex flex-col"
      >
        <div className="p-6 border-b border-white/10 flex justify-between items-center bg-black">
          <h2 className="text-lg font-medium text-white flex items-center gap-2 tracking-tight">
            <Settings size={18} className="text-zinc-400" /> Settings
          </h2>
          <button onClick={onClose} className="text-zinc-500 hover:text-white transition-colors">
            <X size={20} />
          </button>
        </div>
        
        <div className="p-6 bg-zinc-950/50 space-y-8 overflow-y-auto max-h-[60vh] custom-scrollbar">
          <div className="space-y-4">
            <div className="flex items-center gap-3 border-b border-white/5 pb-4">
              <div className="w-12 h-12 rounded-full bg-zinc-800 flex items-center justify-center overflow-hidden border border-white/10">
                {currentUser?.photoURL ? (
                  <img src={currentUser.photoURL} alt="Profile" className="w-full h-full object-cover" />
                ) : (
                  <UserIcon size={24} className="text-zinc-500" />
                )}
              </div>
              <div>
                <p className="text-sm font-medium text-white">{currentUser?.displayName || 'User'}</p>
                <p className="text-xs text-zinc-500">{currentUser?.email}</p>
              </div>
            </div>
          </div>

          <div className="space-y-4">
            <div className="flex items-center gap-2">
               <Shield size={16} className="text-indigo-400" />
               <h3 className="text-sm font-semibold uppercase tracking-widest text-zinc-400">Enterprise Role Simulation</h3>
            </div>
            <p className="text-xs text-zinc-500 font-light leading-relaxed">
               Select your simulated role. Depending on your role, different privileges are granted (e.g., Admins can view Audit Logs; Viewers are restricted to read-only views).
            </p>
            <div className="flex gap-4">
               {['Admin', 'Editor', 'Viewer'].map((r) => (
                 <button
                   key={r}
                   onClick={() => setSelectedRole(r)}
                   className={`flex-1 py-3 text-sm rounded-xl transition-all border ${
                     selectedRole === r 
                       ? 'bg-indigo-500/10 text-indigo-300 border-indigo-500/30 font-medium' 
                       : 'bg-black border-white/10 text-zinc-400 hover:bg-white/5 hover:border-white/20'
                   }`}
                 >
                   {r}
                 </button>
               ))}
            </div>
          </div>

          {/* Model Customization */}
          <div className="space-y-6 pt-6 border-t border-white/5">
            <div className="flex items-center gap-2">
               <Settings size={16} className="text-emerald-400" />
               <h3 className="text-sm font-semibold uppercase tracking-widest text-zinc-400">LLM Model Customizers</h3>
            </div>
            
            {/* Gemini */}
            <div className="space-y-2">
              <div className="flex justify-between items-center text-xs">
                <span className="font-semibold text-zinc-400">Gemini model</span>
                <button 
                  onClick={() => setGeminiCustom(!geminiCustom)} 
                  className="text-zinc-500 hover:text-white transition-colors"
                >
                  {geminiCustom ? "Select preset" : "Set custom model ID"}
                </button>
              </div>
              {geminiCustom ? (
                <input 
                  type="text"
                  value={configs.gemini}
                  onChange={(e) => handleModelChange('gemini', e.target.value)}
                  className="w-full bg-zinc-900 border border-white/10 rounded-xl px-4 py-2.5 text-sm font-mono text-zinc-300 focus:border-white/30"
                  placeholder="e.g. gemini-3.5-flash"
                />
              ) : (
                <select 
                  value={configs.gemini}
                  onChange={(e) => handleModelChange('gemini', e.target.value)}
                  className="w-full bg-black border border-white/10 rounded-xl px-4 py-2.5 text-sm text-zinc-300 focus:border-white/30"
                >
                  <option value="gemini-3.5-flash">Gemini 3.5 Flash (Standard)</option>
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
                <span className="font-semibold text-zinc-400">ChatGPT model</span>
                <button 
                  onClick={() => setChatgptCustom(!chatgptCustom)} 
                  className="text-zinc-500 hover:text-white transition-colors"
                >
                  {chatgptCustom ? "Select preset" : "Set custom model ID"}
                </button>
              </div>
              {chatgptCustom ? (
                <input 
                  type="text"
                  value={configs.chatgpt}
                  onChange={(e) => handleModelChange('chatgpt', e.target.value)}
                  className="w-full bg-zinc-900 border border-white/10 rounded-xl px-4 py-2.5 text-sm font-mono text-zinc-300 focus:border-white/30"
                  placeholder="e.g. gpt-4o"
                />
              ) : (
                <select 
                  value={configs.chatgpt}
                  onChange={(e) => handleModelChange('chatgpt', e.target.value)}
                  className="w-full bg-black border border-white/10 rounded-xl px-4 py-2.5 text-sm text-zinc-300 focus:border-white/30"
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
                <span className="font-semibold text-zinc-400">Claude model</span>
                <button 
                  onClick={() => setClaudeCustom(!claudeCustom)} 
                  className="text-zinc-500 hover:text-white transition-colors"
                >
                  {claudeCustom ? "Select preset" : "Set custom model ID"}
                </button>
              </div>
              {claudeCustom ? (
                <input 
                  type="text"
                  value={configs.claude}
                  onChange={(e) => handleModelChange('claude', e.target.value)}
                  className="w-full bg-zinc-900 border border-white/20 rounded-xl px-4 py-2.5 text-sm font-mono text-zinc-100 focus:border-white/40 shadow-inner"
                  placeholder="e.g. claude-opus-4-8"
                />
              ) : (
                <select 
                  value={configs.claude}
                  onChange={(e) => handleModelChange('claude', e.target.value)}
                  className="w-full bg-black border border-white/10 rounded-xl px-4 py-2.5 text-sm text-zinc-300 focus:border-white/30"
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
                <span className="font-semibold text-zinc-400">Grok model</span>
                <button 
                  onClick={() => setGrokCustom(!grokCustom)} 
                  className="text-zinc-500 hover:text-white transition-colors"
                >
                  {grokCustom ? "Select preset" : "Set custom model ID"}
                </button>
              </div>
              {grokCustom ? (
                <input 
                  type="text"
                  value={configs.grok}
                  onChange={(e) => handleModelChange('grok', e.target.value)}
                  className="w-full bg-zinc-900 border border-white/10 rounded-xl px-4 py-2.5 text-sm font-mono text-zinc-300 focus:border-white/30"
                  placeholder="e.g. grok-2-latest"
                />
              ) : (
                <select 
                  value={configs.grok}
                  onChange={(e) => handleModelChange('grok', e.target.value)}
                  className="w-full bg-black border border-white/10 rounded-xl px-4 py-2.5 text-sm text-zinc-300 focus:border-white/30"
                >
                  <option value="grok-4.3">Grok 4.3 (Flagship)</option>
                  <option value="grok-4.20-reasoning">Grok 4.20 Reasoning</option>
                  <option value="grok-4.20-non-reasoning">Grok 4.20 Fast (Agents)</option>
                  <option value="grok-4.1-fast-reasoning">Grok 4.1 Fast Reasoning (Budget)</option>
                  <option value="grok-build-0.1">Grok Build 0.1 (Coding)</option>
                </select>
              )}
            </div>

            {/* DeepSeek */}
            <div className="space-y-2">
              <div className="flex justify-between items-center text-xs">
                <span className="font-semibold text-zinc-400">DeepSeek model</span>
                <button 
                  onClick={() => setDeepseekCustom(!deepseekCustom)} 
                  className="text-zinc-500 hover:text-white transition-colors"
                >
                  {deepseekCustom ? "Select preset" : "Set custom model ID"}
                </button>
              </div>
              {deepseekCustom ? (
                <input 
                  type="text"
                  value={configs.deepseek}
                  onChange={(e) => handleModelChange('deepseek', e.target.value)}
                  className="w-full bg-zinc-900 border border-white/10 rounded-xl px-4 py-2.5 text-sm font-mono text-zinc-300 focus:border-white/30"
                  placeholder="e.g. deepseek-v4-pro"
                />
              ) : (
                <select 
                  value={configs.deepseek}
                  onChange={(e) => handleModelChange('deepseek', e.target.value)}
                  className="w-full bg-black border border-white/10 rounded-xl px-4 py-2.5 text-sm text-zinc-300 focus:border-white/30"
                >
                  <option value="deepseek-v4-pro">DeepSeek V4 Pro (Reasoning)</option>
                  <option value="deepseek-v4-flash">DeepSeek V4 Flash</option>
                  <option value="deepseek-r1">DeepSeek-R1 (Legacy)</option>
                </select>
              )}
            </div>
          </div>
        </div>

        <div className="p-6 border-t border-white/10 bg-black flex justify-end gap-3">
          <button 
            onClick={onClose}
            className="px-5 py-2.5 rounded-xl border border-white/10 text-sm font-medium text-zinc-300 hover:bg-white/5 transition-colors"
          >
            Cancel
          </button>
          <button 
            onClick={handleSave}
            disabled={loading}
            className="px-5 py-2.5 rounded-xl bg-white text-black text-sm font-medium hover:bg-zinc-200 transition-colors disabled:opacity-50"
          >
            {loading ? 'Saving...' : 'Save Settings'}
          </button>
        </div>
      </motion.div>
    </div>
  );
}
