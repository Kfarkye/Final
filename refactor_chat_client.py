import re

with open('src/ChatClient.tsx', 'r') as f:
    content = f.read()

# Structural wrappers
content = content.replace(
    'className="flex flex-col h-screen bg-black text-white font-sans pb-safe pt-safe selection:bg-zinc-800 relative overflow-hidden"',
    'className="app pb-safe pt-safe"'
)
content = content.replace(
    'className="flex-shrink-0 px-6 py-4 border-b border-white/[0.08] bg-white/[0.03] backdrop-blur-2xl backdrop-saturate-150 flex justify-between items-center sticky top-0 z-20 w-full text-center sm:text-left"',
    'className="flex justify-between items-center px-6 py-4 border-b border-[var(--t-border)] bg-[var(--t-bg-card)] sticky top-0 z-20 w-full"'
)

# Text / Typography
content = content.replace(
    'className="font-serif font-medium text-lg text-white tracking-tight leading-tight flex items-center gap-2"',
    'className="t-h2 flex items-center gap-2"'
)
content = content.replace(
    'className="font-serif text-3xl mb-3 text-white tracking-tight"',
    'className="t-h1 mb-3"'
)
content = content.replace(
    'className="text-zinc-600 text-xs px-2 py-4 italic"',
    'className="t-label px-2 py-4 italic"'
)

# Buttons
content = content.replace(
    'className="p-2 -ml-2 text-zinc-400 hover:text-white transition-colors"',
    'className="t-btn t-btn-ghost p-2 -ml-2"'
)

with open('src/ChatClient.tsx', 'w') as f:
    f.write(content)

