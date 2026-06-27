import re

with open('src/ChatClient.tsx', 'r') as f:
    c = f.read()

# Input UI
c = c.replace(
    'className="flex flex-wrap gap-2 p-3 border-b border-white/5 bg-black/10"',
    'className="flex flex-wrap gap-2 p-3 border-b border-[var(--b1)] bg-[var(--bg)]"'
)
c = c.replace(
    'bg-[#212121]/90 backdrop-blur-xl hover:bg-[#252525]/90 hover:border-white/15 focus-within:bg-[#252525] focus-within:border-white/25 focus-within:shadow-[0_8px_32px_rgba(0,0,0,0.5)]',
    'bg-[var(--s2)] hover:bg-[var(--s3)] border-[var(--b1)] focus-within:border-[var(--nc)] focus-within:shadow-[var(--t-shadow-md)]'
)
c = c.replace(
    'border-white/10',
    'border-[var(--b1)]'
)
c = c.replace(
    'text-zinc-400',
    'text-[var(--t2)]'
)
c = c.replace(
    'text-zinc-300',
    'text-[var(--t3)]'
)
c = c.replace(
    'text-zinc-500',
    'text-[var(--t4)]'
)
c = c.replace(
    'text-zinc-600',
    'text-[var(--t4)]'
)
c = c.replace(
    'bg-zinc-900',
    'bg-[var(--s2)]'
)
c = c.replace(
    'bg-zinc-800',
    'bg-[var(--s3)]'
)
c = c.replace(
    'hover:bg-white/5',
    'hover:bg-[var(--s1)]'
)
c = c.replace(
    'hover:bg-white/10',
    'hover:bg-[var(--s2)]'
)
c = c.replace(
    'bg-white/5',
    'bg-[var(--s1)]'
)
c = c.replace(
    'bg-white/10',
    'bg-[var(--s2)]'
)
c = c.replace(
    'border-zinc-900',
    'border-[var(--b1)]'
)
c = c.replace(
    'border-zinc-800',
    'border-[var(--b2)]'
)
c = c.replace(
    'text-white',
    'text-[var(--t1)]'
)
c = c.replace(
    'text-black',
    'text-[var(--bg)]'
)
c = c.replace(
    'bg-black/40',
    'bg-[var(--s1)]'
)
c = c.replace(
    'bg-black/10',
    'bg-[var(--s1)]'
)
c = c.replace(
    'bg-white',
    'bg-[var(--t1)]'
)
c = c.replace(
    'text-[var(--t1)]/[0.03]',
    'bg-[var(--s1)]'
)
c = c.replace(
    'text-[var(--bg)]/10',
    'border-[var(--b1)]'
)


with open('src/ChatClient.tsx', 'w') as f:
    f.write(c)

