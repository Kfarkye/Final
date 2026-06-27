import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';

interface Suggestion {
  prompt: string;
  model: string;
  label: string;
}

interface SuggestedPromptsProps {
  suggestions: Suggestion[];
  onSelect: (prompt: string, model: string) => void;
}

const MODEL_COLORS: Record<string, { bg: string; text: string; border: string; icon: string }> = {
  gemini: {
    bg: 'bg-blue-500/10',
    text: 'text-blue-400',
    border: 'border-blue-500/20',
    icon: '✦',
  },
  claude: {
    bg: 'bg-amber-500/10',
    text: 'text-amber-400',
    border: 'border-amber-500/20',
    icon: '◈',
  },
  chatgpt: {
    bg: 'bg-emerald-500/10',
    text: 'text-emerald-400',
    border: 'border-emerald-500/20',
    icon: '◉',
  },
  deepseek: {
    bg: 'bg-violet-500/10',
    text: 'text-violet-400',
    border: 'border-violet-500/20',
    icon: '◆',
  },
  grok: {
    bg: 'bg-rose-500/10',
    text: 'text-rose-400',
    border: 'border-rose-500/20',
    icon: '✧',
  },
};

export default function SuggestedPrompts({ suggestions, onSelect }: SuggestedPromptsProps) {
  const [expanded, setExpanded] = useState(false);

  if (!suggestions || suggestions.length === 0) return null;

  return (
    <div className="mt-3 max-w-4xl">
      {/* Progressive disclosure toggle */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="group flex items-center gap-2 px-3 py-1.5 rounded-full
                   bg-[var(--s1)] hover:bg-[var(--s1)] border border-[var(--b1)] hover:border-[var(--b1)]
                   transition-all duration-300 ease-out"
      >
        <span className="text-[10px] font-semibold tracking-widest uppercase text-[var(--t4)] group-hover:text-[var(--t2)] transition-colors">
          Suggested
        </span>
        <div className="flex items-center gap-1">
          {suggestions.slice(0, 3).map((s, i) => {
            const colors = MODEL_COLORS[s.model] || MODEL_COLORS.gemini;
            return (
              <span
                key={i}
                className={`w-1.5 h-1.5 rounded-full ${colors.bg} ${colors.border} border`}
              />
            );
          })}
        </div>
        <svg
          className={`w-3 h-3 text-[var(--t4)] transition-transform duration-300 ${expanded ? 'rotate-180' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2.5}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Expanded suggestions */}
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ opacity: 0, height: 0, marginTop: 0 }}
            animate={{ opacity: 1, height: 'auto', marginTop: 8 }}
            exit={{ opacity: 0, height: 0, marginTop: 0 }}
            transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
            className="overflow-hidden"
          >
            <div className="flex flex-wrap gap-2">
              {suggestions.map((suggestion, index) => {
                const colors = MODEL_COLORS[suggestion.model] || MODEL_COLORS.gemini;
                return (
                  <motion.button
                    key={index}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: index * 0.06, duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
                    onClick={() => onSelect(suggestion.prompt, suggestion.model)}
                    className={`group relative flex items-start gap-2.5 px-3.5 py-2.5 rounded-xl
                               bg-[var(--s1)] hover:bg-[var(--s1)]
                               border border-[var(--b1)] hover:border-[var(--b1)]
                               transition-all duration-200 text-left max-w-[300px]
                               active:scale-[0.98]`}
                  >
                    {/* Model indicator */}
                    <span className={`mt-0.5 text-[10px] font-bold shrink-0 ${colors.text}`}>
                      {colors.icon}
                    </span>

                    <div className="flex flex-col gap-0.5 min-w-0">
                      {/* Label + model badge */}
                      <div className="flex items-center gap-1.5">
                        <span className="text-[10px] font-bold tracking-wider uppercase text-[var(--t2)] group-hover:text-[var(--t3)] transition-colors">
                          {suggestion.label}
                        </span>
                        <span className={`text-[8px] font-bold tracking-wider uppercase px-1.5 py-0.5 rounded-full ${colors.bg} ${colors.text} ${colors.border} border`}>
                          {suggestion.model}
                        </span>
                      </div>

                      {/* Prompt preview */}
                      <span className="text-xs text-[var(--t4)] group-hover:text-[var(--t2)] transition-colors line-clamp-2 leading-relaxed">
                        {suggestion.prompt}
                      </span>
                    </div>

                    {/* Arrow indicator */}
                    <svg
                      className="w-3 h-3 text-[var(--t4)] group-hover:text-[var(--t2)] transition-colors shrink-0 mt-1 opacity-0 group-hover:opacity-100"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2.5}
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
                    </svg>
                  </motion.button>
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
