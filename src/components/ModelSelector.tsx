/**
 * ModelSelector — the premium pill trigger + popover.
 * 
 * Replaces the native <select> in the chat input bar.
 * Shows the current model + version, opens the popover on click.
 * 
 * ARIA: role="combobox", aria-expanded, aria-controls
 * Keyboard: Enter/Space to toggle, Escape to close
 */

import React, { useState, useCallback, useRef } from 'react';
import { ModelPopover } from './ModelPopover';
import { MODEL_REGISTRY } from '../hooks/useModelConfig';

interface ModelSelectorProps {
  mode: 'shared' | 'compare';
  activeProvider: string;
  modelConfigs: Record<string, string>;
  selectedProviders: string[];
  onSelectModel: (providerId: string, versionId: string) => void;
  onToggleCompare: (providerId: string) => void;
  onModeChange?: (mode: 'shared' | 'compare') => void;
}

export function ModelSelector({
  mode,
  activeProvider,
  modelConfigs,
  selectedProviders,
  onSelectModel,
  onToggleCompare,
  onModeChange,
}: ModelSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const close = useCallback(() => {
    setIsOpen(false);
    triggerRef.current?.focus();
  }, []);

  // Get display info
  const provider = MODEL_REGISTRY.find(p => p.id === activeProvider);
  const version = provider?.versions.find(v => v.id === modelConfigs[activeProvider]);
  const displayText = mode === 'shared'
    ? `${provider?.name || activeProvider} · ${version?.label || modelConfigs[activeProvider] || ''}`
    : `${selectedProviders.length} models`;

  return (
    <div style={{ position: 'relative' }}>
      <style>{`
        .ms-trigger {
          display: flex;
          align-items: center;
          gap: 8px;
          height: 36px;
          padding: 0 14px;
          background: #27272a;
          border: 1px solid rgba(255,255,255,0.08);
          border-radius: 999px;
          color: #e4e4e7;
          font-size: 12px;
          font-weight: 600;
          letter-spacing: 0.01em;
          cursor: pointer;
          transition: all 0.2s cubic-bezier(.22,1,.36,1);
          outline: none;
          white-space: nowrap;
          font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", system-ui, sans-serif;
        }
        .ms-trigger:hover {
          background: #303036;
          border-color: rgba(255,255,255,0.14);
          transform: translateY(-1px);
          box-shadow: 0 4px 16px -4px rgba(0,0,0,0.4);
        }
        .ms-trigger:focus-visible {
          box-shadow: 0 0 0 2px rgba(125,242,255,0.4);
          border-color: rgba(125,242,255,0.3);
        }
        .ms-trigger[aria-expanded="true"] {
          background: #303036;
          border-color: rgba(125,242,255,0.2);
        }

        .ms-dot {
          width: 7px;
          height: 7px;
          border-radius: 50%;
          flex-shrink: 0;
          box-shadow: 0 0 6px currentColor;
        }
        .ms-chevron {
          transition: transform 0.2s;
          opacity: 0.5;
        }
        .ms-trigger[aria-expanded="true"] .ms-chevron {
          transform: rotate(180deg);
        }

        .ms-mode-toggle {
          display: flex;
          padding: 2px;
          background: rgba(255,255,255,0.05);
          border-radius: 999px;
          gap: 1px;
          margin-right: 4px;
        }
        .ms-mode-btn {
          padding: 3px 10px;
          border-radius: 999px;
          font-size: 10px;
          font-weight: 600;
          letter-spacing: 0.05em;
          text-transform: uppercase;
          color: #6b7280;
          cursor: pointer;
          transition: all 0.2s;
          border: none;
          background: transparent;
        }
        .ms-mode-btn:hover {
          color: #9ca3af;
        }
        .ms-mode-btn-active {
          background: rgba(255,255,255,0.1);
          color: #e4e4e7;
        }

        @media (prefers-reduced-motion: reduce) {
          .ms-trigger, .ms-chevron { transition: none; }
          .ms-trigger:hover { transform: none; }
        }
      `}</style>

      {/* Mode toggle (shared / compare) */}
      {onModeChange && (
        <div className="ms-mode-toggle" style={{ position: 'absolute', bottom: 'calc(100% + 4px)', left: 0 }}>
          <button
            className={`ms-mode-btn ${mode === 'shared' ? 'ms-mode-btn-active' : ''}`}
            onClick={() => onModeChange('shared')}
          >
            Single
          </button>
          <button
            className={`ms-mode-btn ${mode === 'compare' ? 'ms-mode-btn-active' : ''}`}
            onClick={() => onModeChange('compare')}
          >
            Compare
          </button>
        </div>
      )}

      {/* Trigger pill */}
      <button
        ref={triggerRef}
        className="ms-trigger"
        role="combobox"
        aria-expanded={isOpen}
        aria-controls="model-popover"
        aria-label={`Selected model: ${displayText}`}
        aria-haspopup="listbox"
        onClick={() => setIsOpen(!isOpen)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setIsOpen(!isOpen);
          }
          if (e.key === 'Escape' && isOpen) {
            e.preventDefault();
            close();
          }
        }}
      >
        <div
          className="ms-dot"
          style={{ color: provider?.accent || '#888', background: provider?.accent || '#888' }}
        />
        <span>{displayText}</span>
        <svg className="ms-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {/* Popover */}
      <ModelPopover
        isOpen={isOpen}
        onClose={close}
        mode={mode}
        registry={MODEL_REGISTRY}
        activeProvider={activeProvider}
        modelConfigs={modelConfigs}
        selectedProviders={selectedProviders}
        onSelectModel={onSelectModel}
        onToggleCompare={onToggleCompare}
      />
    </div>
  );
}
