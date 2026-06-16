/**
 * ModelPopover — the premium dropdown that replaces native <select>.
 * 
 * Features:
 * - Grouped by provider with accent colors
 * - Radio (shared) or checkbox (compare) selection
 * - Capability hints (fast / balanced / reasoning)
 * - Full keyboard navigation + ARIA
 * - Escape to close, arrow keys to navigate
 */

import React, { useEffect, useRef, useCallback } from 'react';
import { ModelProvider, ModelVersion } from '../hooks/useModelConfig';

interface ModelPopoverProps {
  isOpen: boolean;
  onClose: () => void;
  mode: 'shared' | 'compare';
  registry: ModelProvider[];
  activeProvider: string;
  modelConfigs: Record<string, string>;
  selectedProviders: string[];
  onSelectModel: (providerId: string, versionId: string) => void;
  onToggleCompare: (providerId: string) => void;
}

const HINT_COLORS: Record<string, string> = {
  fast: '#5eead4',
  balanced: '#7df2ff',
  reasoning: '#c6a3ff',
  creative: '#fbbf24',
};

export function ModelPopover({
  isOpen,
  onClose,
  mode,
  registry,
  activeProvider,
  modelConfigs,
  selectedProviders,
  onSelectModel,
  onToggleCompare,
}: ModelPopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const focusedIndex = useRef(0);

  // Close on escape
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isOpen, onClose]);

  // Close on outside click
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    // Delay to avoid the click that opened it
    const timer = setTimeout(() => {
      window.addEventListener('mousedown', handler);
    }, 10);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('mousedown', handler);
    };
  }, [isOpen, onClose]);

  // Keyboard navigation
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    const items = popoverRef.current?.querySelectorAll('[data-model-item]');
    if (!items) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      focusedIndex.current = Math.min(focusedIndex.current + 1, items.length - 1);
      (items[focusedIndex.current] as HTMLElement).focus();
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      focusedIndex.current = Math.max(focusedIndex.current - 1, 0);
      (items[focusedIndex.current] as HTMLElement).focus();
    }
  }, []);

  if (!isOpen) return null;

  return (
    <div
      ref={popoverRef}
      role="listbox"
      aria-label="Select AI model"
      onKeyDown={handleKeyDown}
      className="model-popover"
    >
      <style>{`
        .model-popover {
          position: absolute;
          bottom: calc(100% + 8px);
          left: 0;
          min-width: 280px;
          max-width: 320px;
          max-height: 420px;
          overflow-y: auto;
          background: linear-gradient(180deg, #18181b, #111113);
          border: 1px solid rgba(255,255,255,0.08);
          border-radius: 16px;
          box-shadow:
            0 -4px 40px -10px rgba(0,0,0,0.6),
            0 0 0 1px rgba(255,255,255,0.04) inset;
          padding: 6px 0;
          z-index: 100;
          animation: mp-enter 0.2s cubic-bezier(.22,1,.36,1);
          scrollbar-width: thin;
          scrollbar-color: rgba(255,255,255,0.1) transparent;
        }
        @keyframes mp-enter {
          from { opacity: 0; transform: translateY(6px) scale(0.97); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }

        .mp-group {
          padding: 4px 0;
        }
        .mp-group + .mp-group {
          border-top: 1px solid rgba(255,255,255,0.05);
        }
        .mp-group-header {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 8px 16px 4px;
          font-size: 10px;
          font-weight: 700;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: #6b7280;
        }
        .mp-group-dot {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          flex-shrink: 0;
        }

        .mp-item {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 8px 16px;
          cursor: pointer;
          transition: background 0.15s;
          outline: none;
          font-size: 13px;
          color: #d1d5db;
        }
        .mp-item:hover, .mp-item:focus-visible {
          background: rgba(255,255,255,0.05);
        }
        .mp-item:focus-visible {
          box-shadow: 0 0 0 2px rgba(125,242,255,0.3) inset;
        }
        .mp-item[aria-selected="true"] {
          color: #f9fafb;
        }

        .mp-radio {
          width: 16px;
          height: 16px;
          border-radius: 50%;
          border: 2px solid rgba(255,255,255,0.15);
          display: flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
          transition: border-color 0.2s;
        }
        .mp-radio-active {
          border-color: rgba(125,242,255,0.6);
        }
        .mp-radio-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: #7df2ff;
          transform: scale(0);
          transition: transform 0.15s cubic-bezier(.22,1,.36,1);
        }
        .mp-radio-active .mp-radio-dot {
          transform: scale(1);
        }

        .mp-check {
          width: 16px;
          height: 16px;
          border-radius: 5px;
          border: 2px solid rgba(255,255,255,0.15);
          display: flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
          transition: border-color 0.2s, background 0.2s;
        }
        .mp-check-active {
          border-color: #7df2ff;
          background: rgba(125,242,255,0.15);
        }
        .mp-check-mark {
          opacity: 0;
          transition: opacity 0.15s;
          color: #7df2ff;
        }
        .mp-check-active .mp-check-mark {
          opacity: 1;
        }

        .mp-label {
          flex: 1;
          font-weight: 500;
        }
        .mp-hint {
          font-size: 10px;
          font-weight: 600;
          padding: 1px 7px;
          border-radius: 999px;
          letter-spacing: 0.03em;
          opacity: 0.75;
        }

        @media (prefers-reduced-motion: reduce) {
          .model-popover { animation: none; }
          .mp-radio-dot, .mp-check-mark { transition: none; }
        }
      `}</style>

      {registry.map((provider) => (
        <div key={provider.id} className="mp-group">
          <div className="mp-group-header">
            <div className="mp-group-dot" style={{ background: provider.accent }} />
            <span>{provider.name}</span>
            {mode === 'compare' && (
              <label
                style={{
                  marginLeft: 'auto',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                }}
              >
                <div
                  className={`mp-check ${selectedProviders.includes(provider.id) ? 'mp-check-active' : ''}`}
                  style={{ width: 14, height: 14, borderRadius: 4 }}
                  onClick={(e) => { e.stopPropagation(); onToggleCompare(provider.id); }}
                >
                  <svg className="mp-check-mark" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                </div>
              </label>
            )}
          </div>

          {provider.versions.map((version, vi) => {
            const isActive = mode === 'shared'
              ? (activeProvider === provider.id && modelConfigs[provider.id] === version.id)
              : false;

            return (
              <div
                key={version.id}
                data-model-item
                role="option"
                aria-selected={isActive}
                aria-label={`${provider.name} ${version.label}${version.hint ? `, ${version.hint}` : ''}`}
                tabIndex={0}
                className="mp-item"
                onClick={() => {
                  onSelectModel(provider.id, version.id);
                  if (mode === 'shared') onClose();
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelectModel(provider.id, version.id);
                    if (mode === 'shared') onClose();
                  }
                }}
              >
                {/* Radio / Checkbox indicator */}
                {mode === 'shared' ? (
                  <div className={`mp-radio ${isActive ? 'mp-radio-active' : ''}`}>
                    <div className="mp-radio-dot" />
                  </div>
                ) : (
                  <div className={`mp-check ${selectedProviders.includes(provider.id) && modelConfigs[provider.id] === version.id ? 'mp-check-active' : ''}`}>
                    <svg className="mp-check-mark" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  </div>
                )}

                <span className="mp-label">{version.label}</span>

                {version.hint && (
                  <span
                    className="mp-hint"
                    style={{
                      color: HINT_COLORS[version.hint] || '#888',
                      background: `${HINT_COLORS[version.hint] || '#888'}15`,
                    }}
                  >
                    {version.hint}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
