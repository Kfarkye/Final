/**
 * useModelConfig — state management for the model selector.
 * 
 * Handles encoding/decoding of provider::version values,
 * shared vs compare mode, and persistence.
 */

import { useState, useCallback, useMemo } from 'react';

// ── Types ───────────────────────────────────────────────────────────────

export interface ModelVersion {
  id: string;
  label: string;
  hint?: string;   // "fast" | "balanced" | "reasoning" | "creative"
}

export interface ModelProvider {
  id: string;
  name: string;
  accent: string;   // color for the provider badge
  versions: ModelVersion[];
}

export interface ModelState {
  mode: 'shared' | 'compare';
  activeProvider: string;
  modelConfigs: Record<string, string>;
  selectedProviders: string[];
}

// ── Model Registry ──────────────────────────────────────────────────────

export const MODEL_REGISTRY: ModelProvider[] = [
  {
    id: 'gemini',
    name: 'Gemini',
    accent: '#4285F4',
    versions: [
      { id: 'gemini-3.5-flash', label: '3.5 Flash', hint: 'fast' },
      { id: 'gemini-3.5-flash-puppeteer', label: '3.5 Flash (Puppeteer)', hint: 'fast' },
      { id: 'gemini-3.1-pro-preview', label: '3.1 Pro', hint: 'balanced' },
      { id: 'gemini-3.1-pre-preview', label: 'Deep Think', hint: 'reasoning' },
      { id: 'gemini-3.1-pro-preview-next', label: 'Deep Think Next', hint: 'reasoning' },
      { id: 'gemini-3.1-flash-lite', label: '3.1 Flash Lite', hint: 'fast' },
    ],
  },
  {
    id: 'chatgpt',
    name: 'ChatGPT',
    accent: '#10A37F',
    versions: [
      { id: 'gpt-5.5', label: 'GPT-5.5', hint: 'reasoning' },
      { id: 'gpt-5.4', label: 'GPT-5.4', hint: 'balanced' },
      { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini', hint: 'fast' },
      { id: 'gpt-5.4-nano', label: 'GPT-5.4 nano', hint: 'fast' },
    ],
  },
  {
    id: 'claude',
    name: 'Claude',
    accent: '#D97706',
    versions: [
      { id: 'claude-fable-5', label: 'Fable 5', hint: 'reasoning' },
      { id: 'claude-sonnet-5', label: 'Sonnet 5', hint: 'fast' },
      { id: 'claude-opus-4-8', label: 'Opus 4.8', hint: 'balanced' },
      { id: 'claude-opus-4-6', label: 'Opus 4.6', hint: 'balanced' },
      { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', hint: 'fast' },
    ],
  },
  {
    id: 'grok',
    name: 'Grok',
    accent: '#EF4444',
    versions: [
      { id: 'grok-4.3', label: '4.3', hint: 'balanced' },
      { id: 'grok-4.20-reasoning', label: '4.20 Reasoning', hint: 'reasoning' },
      { id: 'grok-4.20-non-reasoning', label: '4.20 Fast', hint: 'fast' },
      { id: 'grok-4.1-fast-reasoning', label: '4.1 Fast Reasoning', hint: 'fast' },
    ],
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    accent: '#8B5CF6',
    versions: [
      { id: 'deepseek-v3.2-maas', label: 'V3.2', hint: 'balanced' },
      { id: 'deepseek-r1-0528-maas', label: 'R1 0528', hint: 'reasoning' },
      { id: 'deepseek-v3.1-maas', label: 'V3.1', hint: 'fast' },
      { id: 'deepseek-ocr-maas', label: 'OCR', hint: 'fast' },
    ],
  },
  {
    id: 'codex',
    name: 'Codex',
    accent: '#22C55E',
    versions: [
      { id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex', hint: 'reasoning' },
      { id: 'gpt-5.5', label: 'GPT-5.5', hint: 'reasoning' },
      { id: 'gpt-5.4', label: 'GPT-5.4', hint: 'balanced' },
      { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini', hint: 'fast' },
    ],
  },
];

// ── Hook ────────────────────────────────────────────────────────────────

export function useModelConfig(initial?: Partial<ModelState>) {
  const [mode, setMode] = useState<'shared' | 'compare'>(initial?.mode || 'shared');
  const [activeProvider, setActiveProvider] = useState(initial?.activeProvider || 'gemini');
  const [modelConfigs, setModelConfigs] = useState<Record<string, string>>(
    initial?.modelConfigs || {
      gemini: 'gemini-3.5-flash',
      chatgpt: 'gpt-5.5-2026-04-23',
      claude: 'claude-opus-4-8',
      grok: 'grok-4.3',
      deepseek: 'deepseek-v4-pro',
      codex: 'gpt-5.3-codex',
    }
  );
  const [selectedProviders, setSelectedProviders] = useState<string[]>(
    initial?.selectedProviders || ['gemini', 'chatgpt', 'claude']
  );

  // Encode to provider::version
  const encoded = useMemo(() => {
    return `${activeProvider}::${modelConfigs[activeProvider] || ''}`;
  }, [activeProvider, modelConfigs]);

  // Select a model (shared mode)
  const selectModel = useCallback((providerId: string, versionId: string) => {
    setActiveProvider(providerId);
    setModelConfigs(prev => ({ ...prev, [providerId]: versionId }));
  }, []);

  // Toggle a provider in compare mode
  const toggleCompareProvider = useCallback((providerId: string) => {
    setSelectedProviders(prev => {
      if (prev.includes(providerId)) {
        if (prev.length <= 2) return prev; // min 2
        return prev.filter(p => p !== providerId);
      }
      if (prev.length >= 4) return prev; // max 4
      return [...prev, providerId];
    });
  }, []);

  // Get display info for current selection
  const activeDisplay = useMemo(() => {
    const provider = MODEL_REGISTRY.find(p => p.id === activeProvider);
    if (!provider) return { provider: 'Unknown', version: '', accent: '#888' };
    const version = provider.versions.find(v => v.id === modelConfigs[activeProvider]);
    return {
      provider: provider.name,
      version: version?.label || modelConfigs[activeProvider] || '',
      accent: provider.accent,
      hint: version?.hint,
    };
  }, [activeProvider, modelConfigs]);

  return {
    mode,
    setMode,
    activeProvider,
    modelConfigs,
    setModelConfigs,
    selectedProviders,
    encoded,
    selectModel,
    toggleCompareProvider,
    activeDisplay,
    registry: MODEL_REGISTRY,
  };
}
