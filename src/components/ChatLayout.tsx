import React, { useState } from 'react';
import { Send, Terminal, Hash, MessageSquare, ShieldAlert, Cpu } from 'lucide-react';

// Mock raw developer metadata that was previously bleeding into the UI
const RAW_METADATA_STREAM = `
{
  "trace_id": "0x3f2a89c9210041b89be982c78a0d9b1a",
  "span_id": "0x98f219a1",
  "service": "chat-gateway-v2",
  "environment": "production-us-east-2",
  "k8s": {
    "pod_name": "chat-service-67b4f8d5bc-9qxlk",
    "node_ip": "10.240.0.14",
    "cpu_limit": "2000m",
    "memory_limit": "2Gi"
  },
  "db_spans": [
    { "query": "SELECT * FROM chat_messages WHERE room_id = $1 ORDER BY created_at DESC LIMIT 50", "duration_ms": 1.45 },
    { "query": "UPDATE active_connections SET last_ping = NOW() WHERE ws_id = $2", "duration_ms": 0.89 }
  ],
  "ws_connection": {
    "protocol": "wss",
    "heartbeat_interval_ms": 30000,
    "buffer_size_bytes": 1048576
  }
}
`.repeat(3); // Multiplied to fill the screen background

interface Message {
  id: string;
  sender: 'user' | 'assistant';
  text: string;
  timestamp: string;
}

export default function ChatLayout() {
  const [messages, setMessages] = useState<Message[]>([
    {
      id: '1',
      sender: 'assistant',
      text: "Hello! I'm your AI assistant. How can I help you today?",
      timestamp: '10:42 AM',
    },
    {
      id: '2',
      sender: 'user',
      text: "I'm testing the UI to make sure that developer logs and background metadata are completely invisible to interaction and safely tucked behind this conversation interface.",
      timestamp: '10:43 AM',
    },
    {
      id: '3',
      sender: 'assistant',
      text: "Understood. The stacking context is strictly isolated. You can highlight this text, click buttons, and scroll without hitting any background element barriers.",
      timestamp: '10:43 AM',
    },
  ]);
  const [inputVal, setInputVal] = useState('');

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputVal.trim()) return;

    const newMessage: Message = {
      id: Date.now().toString(),
      sender: 'user',
      text: inputVal,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };

    setMessages((prev) => [...prev, newMessage]);
    setInputVal('');
  };

  return (
    <div 
      className="relative flex h-screen w-screen overflow-hidden bg-slate-950 font-sans text-slate-100 isolate"
      aria-label="Secure Stacked Chat Workspace"
    >
      {/* 
        LAYER 1: ISOLATED BACKGROUND WATERMARK (The Bug Fix)
        - `z-0`: Strictly anchored at the bottom of the local stacking context.
        - `pointer-events-none`: Ensures mouse pointer events (clicks, scrolls, selection) pass right through.
        - `select-none`: Prevents accidental highlight/selection of backend noise when highlighting chat logs.
      */}
      <div 
        className="absolute inset-0 z-0 overflow-hidden p-6 opacity-[0.03] select-none pointer-events-none font-mono text-xs text-emerald-400 whitespace-pre-wrap leading-relaxed"
        aria-hidden="true"
      >
        <div className="uppercase tracking-widest text-[10px] font-bold border-b border-emerald-500/20 pb-1 mb-2">
          SYSTEM_METADATA_STREAM_SHIELDED
        </div>
        {RAW_METADATA_STREAM}
      </div>

      {/* 
        LAYER 2: MAIN CHAT INTERACTIVE UI
        - `z-10`: Explicitly raised above the metadata layer (z-0).
        - `pointer-events-auto`: Restores clickability, highlighting, and inputs safely.
        - `bg-transparent`: Allows the subtle background aesthetic to exist without clipping.
      */}
      <main className="relative z-10 flex h-full w-full pointer-events-auto">
        
        {/* Sidebar Panel */}
        <aside className="hidden md:flex w-72 flex-col border-r border-slate-800 bg-slate-900/60 backdrop-blur-md">
          <div className="flex h-16 items-center px-6 border-b border-slate-800 gap-2">
            <Cpu className="h-5 w-5 text-indigo-400" />
            <span className="font-semibold tracking-tight text-sm uppercase text-slate-300">Secure Environment</span>
          </div>
          <nav className="flex-1 overflow-y-auto p-4 space-y-2">
            <div className="px-3 py-2 text-xs font-semibold text-slate-500 uppercase tracking-wider">
              Active Sessions
            </div>
            <button className="flex w-full items-center gap-3 rounded-lg bg-indigo-600/15 px-3 py-2.5 text-sm text-indigo-200 transition-colors hover:bg-indigo-600/25">
              <MessageSquare className="h-4 w-4 text-indigo-400" />
              <span>General Chat</span>
            </button>
            <button className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-slate-400 transition-colors hover:bg-slate-800/50 hover:text-slate-200">
              <Hash className="h-4 w-4" />
              <span>Sandbox Console</span>
            </button>
          </nav>
          <div className="p-4 border-t border-slate-800">
            <div className="flex items-center gap-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20 p-3 text-xs text-emerald-400">
              <Terminal className="h-4 w-4 shrink-0" />
              <span className="font-mono truncate">Stacking Context: isolated</span>
            </div>
          </div>
        </aside>

        {/* Chat Interface Column */}
        <section className="flex flex-1 flex-col h-full bg-transparent">
          
          {/* Header */}
          <header className="flex h-16 items-center justify-between border-b border-slate-800 px-6 backdrop-blur-md bg-slate-950/40">
            <div className="flex items-center gap-2">
              <h1 className="font-semibold text-slate-100">AI Engine Sandbox</h1>
              <span className="inline-flex items-center rounded-full bg-indigo-500/10 px-2.5 py-0.5 text-xs font-medium text-indigo-400 border border-indigo-500/20">
                v2.4-stable
              </span>
            </div>
            <div className="flex items-center gap-2 text-xs text-amber-500 bg-amber-500/10 border border-amber-500/20 px-3 py-1.5 rounded-md">
              <ShieldAlert className="h-3.5 w-3.5" />
              <span className="font-medium hidden sm:inline">Stacking Context Shielding Active</span>
            </div>
          </header>

          {/* Message List Area */}
          <div className="flex-1 overflow-y-auto p-6 space-y-6">
            <div className="mx-auto max-w-3xl space-y-6">
              {messages.map((message) => (
                <div
                  key={message.id}
                  className={`flex gap-4 ${
                    message.sender === 'user' ? 'justify-end' : 'justify-start'
                  }`}
                >
                  <div
                    className={`max-w-[80%] rounded-2xl p-4 shadow-lg border ${
                      message.sender === 'user'
                        ? 'bg-indigo-600 border-indigo-500 text-white'
                        : 'bg-slate-900 border-slate-800 text-slate-200'
                    }`}
                  >
                    <p className="text-sm leading-relaxed whitespace-pre-wrap">
                      {message.text}
                    </p>
                    <span className="mt-1.5 block text-[10px] text-slate-400 text-right">
                      {message.timestamp}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Chat Input Bar */}
          <div className="p-6 border-t border-slate-900 bg-slate-950/80 backdrop-blur-md">
            <form onSubmit={handleSend} className="mx-auto max-w-3xl">
              <div className="relative flex items-center rounded-xl bg-slate-900 border border-slate-800 focus-within:border-indigo-500 focus-within:ring-2 focus-within:ring-indigo-500/20 transition-all px-4 py-3">
                <input
                  type="text"
                  value={inputVal}
                  onChange={(e) => setInputVal(e.target.value)}
                  placeholder="Ask a question or type a system command..."
                  className="flex-1 bg-transparent text-sm text-slate-100 placeholder-slate-500 outline-none"
                />
                <button
                  type="submit"
                  className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600 text-white transition-all hover:bg-indigo-500 active:scale-95 shadow"
                  aria-label="Send Message"
                >
                  <Send className="h-4 w-4" />
                </button>
              </div>
            </form>
          </div>
        </section>
      </main>
    </div>
  );
}
