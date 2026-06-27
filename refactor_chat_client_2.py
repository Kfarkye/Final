import re

with open('src/ChatClient.tsx', 'r') as f:
    c = f.read()

# Card Replacement
c = c.replace(
    'className={`bg-white/[0.03] backdrop-blur-xl border text-left rounded-2xl p-6 flex flex-col h-full transition-all duration-300 ${isBase && mode !== \'team\' ? \'border-white/20 ring-1 ring-white/10 shadow-[0_0_20px_rgba(255,255,255,0.04)]\' : \'border-white/[0.06] hover:border-white/[0.12] hover:bg-white/[0.05]\'}`}',
    'className={`t-card p-6 flex flex-col h-full ${isBase && mode !== \'team\' ? \'border-[var(--nc)] shadow-[var(--t-shadow-md)]\' : \'\'}`}'
)

c = c.replace(
    'className="font-serif font-medium text-white mb-4 border-b border-white/10 pb-3 flex items-center justify-between"',
    'className="t-h3 mb-4 border-b border-[var(--b1)] pb-3 flex items-center justify-between text-[var(--t1)]"'
)

c = c.replace(
    'className={`text-sm leading-relaxed overflow-hidden break-words flex-1 font-light ${isErrorOrMissing ? \'text-red-400 italic\' : \'text-zinc-300\'}`}',
    'className={`t-body overflow-hidden break-words flex-1 ${isErrorOrMissing ? \'text-[var(--t-rose)] italic\' : \'\'}`}'
)

c = c.replace(
    'className="text-[10px] bg-zinc-900 hover:bg-zinc-800 border border-white/10 hover:border-white/20 text-zinc-400 hover:text-white px-2.5 py-1 rounded-full font-sans transition-all flex items-center space-x-1 cursor-pointer"',
    'className="sql-btn border border-[var(--b1)] rounded-full px-2.5 py-1 flex items-center space-x-1"'
)

c = c.replace(
    'className="text-[10px] bg-white text-black px-2 py-0.5 rounded-full uppercase tracking-[0.2em] font-sans font-bold shadow-[0_0_10px_rgba(255,255,255,0.2)]"',
    'className="t-badge t-badge-cyan ml-2"'
)

c = c.replace(
    'className="hidden md:flex bg-white/[0.06] backdrop-blur-xl border border-white/[0.08] p-1 rounded-full text-xs font-semibold tracking-wide"',
    'className="hidden md:flex t-card-glass p-1 rounded-full text-[var(--t2)]"'
)

c = c.replace(
    'className="flex space-x-1.5 items-center h-full opacity-50 py-2"',
    'className="t-skeleton w-full h-12"'
)

c = c.replace(
    '<div className="w-1.5 h-1.5 rounded-full bg-white animate-bounce" style={{ animationDelay: \'0ms\' }} />\n              <div className="w-1.5 h-1.5 rounded-full bg-white animate-bounce" style={{ animationDelay: \'150ms\' }} />\n              <div className="w-1.5 h-1.5 rounded-full bg-white animate-bounce" style={{ animationDelay: \'300ms\' }} />',
    ''
)

c = c.replace(
    'className="flex justify-end relative"',
    'className="flex justify-end relative mb-[var(--t-space-sm)]"'
)

c = c.replace(
    'className="max-w-[85%] sm:max-w-[60%] p-5 rounded-2xl leading-relaxed text-sm sm:text-base bg-white text-black rounded-tr-sm shadow-[0_0_20px_rgba(255,255,255,0.1)]"',
    'className="max-w-[85%] sm:max-w-[60%] p-[var(--t-space-md)] rounded-[var(--t-radius-md)] leading-relaxed t-body bg-[var(--t1)] text-[var(--bg)] rounded-tr-sm shadow-[var(--t-shadow-md)]"'
)

c = c.replace(
    'className="grid gap-6 grid-cols-1 md:grid-cols-2 lg:grid-cols-4 xl:grid-cols-5"',
    'className="t-grid-4 w-full"'
)
c = c.replace(
    'className={`grid gap-6 ${turn.targeted.length === 1 ? \'grid-cols-1 max-w-4xl mr-auto\' : \'grid-cols-1 md:grid-cols-2 lg:grid-cols-4 xl:grid-cols-5\'}`}',
    'className={`${turn.targeted.length === 1 ? \'max-w-4xl mr-auto\' : \'t-grid-4 w-full\'}`}'
)

c = c.replace(
    'className="flex items-center space-x-4 flex-1"',
    'className="flex items-center space-x-4 flex-1 font-mono"'
)

c = c.replace(
    'className="font-serif text-3xl mb-3 text-white tracking-tight"',
    'className="t-h1 mb-3"'
)

c = c.replace(
    'className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-white/5 border border-white/10 mb-6"',
    'className="inline-flex items-center justify-center w-16 h-16 rounded-full t-card mb-6"'
)

c = c.replace(
    'className="font-serif font-medium text-lg text-white tracking-tight leading-tight flex items-center gap-2"',
    'className="t-h2 flex items-center gap-2"'
)

c = c.replace(
    'className="flex flex-col h-screen bg-black text-white font-sans pb-safe pt-safe selection:bg-zinc-800 relative overflow-hidden"',
    'className="app pb-safe pt-safe"'
)

c = c.replace(
    'className="flex flex-1 overflow-hidden relative"',
    'className="body flex flex-1 relative"'
)

c = c.replace(
    'className="flex-shrink-0 px-6 py-4 border-b border-white/[0.08] bg-white/[0.03] backdrop-blur-2xl backdrop-saturate-150 flex justify-between items-center sticky top-0 z-20 w-full text-center sm:text-left"',
    'className="flex justify-between items-center px-[var(--t-space-lg)] py-[var(--t-space-md)] border-b border-[var(--b1)] bg-[var(--s2)] sticky top-0 z-20 w-full"'
)

c = c.replace(
    'className="p-2 -ml-2 text-zinc-400 hover:text-white transition-colors"',
    'className="t-btn t-btn-ghost p-2 -ml-2"'
)

c = c.replace(
    'className="flex justify-between items-center mb-3 pr-2"',
    'className="t-h3 flex justify-between items-center mb-3 pr-2"'
)

with open('src/ChatClient.tsx', 'w') as f:
    f.write(c)
