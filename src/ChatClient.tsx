import React, { useState, useEffect, useRef } from 'react';
import { copyToClipboard } from './utils/clipboard';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'motion/react';
import { auth, db, getAccessToken, initAuth } from './lib/firebase';
import { signOut } from 'firebase/auth';
import { doc, getDoc, collection, setDoc, addDoc, serverTimestamp, updateDoc, onSnapshot, query, orderBy, deleteDoc, getDocs, limit } from 'firebase/firestore';
import WorkspaceHub from './components/WorkspaceHub';
import GitWorkspaceHub from './components/GitWorkspaceHub';
import WorkspaceModeToggle from './components/WorkspaceModeToggle';
import McpRegistry, { PRELOADED_SERVERS } from './components/McpRegistry';
import CredentialVault from './components/CredentialVault';
import { logAuditAction } from './lib/audit';

import ExportDialog from './components/ExportDialog';
import AuditDialog from './components/AuditDialog';
import SettingsDialog from './components/SettingsDialog';
import { MimeRenderer } from './components/MimeRenderer';
import { ToolTrace, ToolTraceEntry } from './components/ToolTrace';
import { ModelSelector } from './components/ModelSelector';
import SuggestedPrompts from './components/SuggestedPrompts';

import { useFileAttachment } from './components/attachments/useFileAttachment';
import { FileChip } from './components/attachments/FileChip';
import { FileAttachmentError } from './components/attachments/types';
import { formatCodexStreamError } from './lib/codexStreamError';

interface Responses {
  gemini: string | null;
  chatgpt: string | null;
  claude: string | null;
  grok: string | null;
  deepseek: string | null;
  codex: string | null;
  planner?: string | null;
  ui_engineer?: string | null;
  data_analyst?: string | null;
  [key: string]: string | null | undefined;
}

interface Suggestion {
  prompt: string;
  model: string;
  label: string;
}

interface Turn {
  id: number;
  prompt: string;
  responses: Responses | null;
  targeted: string[];
  attachments?: { name: string; size: number; type: string }[];
  trace?: ToolTraceEntry[];
  suggestions?: Suggestion[];
}

export interface ModelConfigs {
  [key: string]: string;
  gemini: string;
  chatgpt: string;
  claude: string;
  grok: string;
  deepseek: string;
  codex: string;
}

export const DOMAINS = [
  { id: 'DEV', label: 'DEV / CODE', color: 'text-blue-400 bg-blue-400/10 border-blue-400/20' },
  { id: 'SPORTS', label: 'SPORTS / DATA', color: 'text-green-400 bg-green-400/10 border-green-400/20' },
  { id: 'OPS', label: 'OPS / AUTO', color: 'text-amber-400 bg-amber-400/10 border-amber-400/20' },
  { id: 'GENERAL', label: 'GENERAL', color: 'text-zinc-400 bg-zinc-400/10 border-zinc-400/20' }
];

interface Conversation {
  id: string;
  title: string;
  mode: string;
  topic: string;
  updatedAt: any;
}

const createEmptyResponses = (): Responses => ({
  gemini: null,
  chatgpt: null,
  claude: null,
  grok: null,
  deepseek: null,
  codex: null,
});

// ═══════════════════════════════════════════════════════════════════════════════
// Approval Notification Utilities (v3)
// ═══════════════════════════════════════════════════════════════════════════════

let audioCtx: AudioContext | null = null;

/** Play an attention-grabbing notification tone using Web Audio API (no file needed) */
function playApprovalSound() {
  try {
    if (!audioCtx) audioCtx = new AudioContext();
    const ctx = audioCtx;

    // Two-tone chime: C5 → E5 (like a doorbell)
    const playTone = (freq: number, startTime: number, duration: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.3, startTime);
      gain.gain.exponentialRampToValueAtTime(0.01, startTime + duration);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(startTime);
      osc.stop(startTime + duration);
    };

    const now = ctx.currentTime;
    playTone(523, now, 0.15);       // C5
    playTone(659, now + 0.18, 0.2); // E5
    playTone(784, now + 0.4, 0.25); // G5
  } catch {
    // Audio not available — silent fallback
  }
}

/** Request browser notification permission on first interaction */
function requestNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
}

/** Send an OS-level browser notification */
function sendBrowserNotification(tool: string, isRePing = false) {
  if ('Notification' in window && Notification.permission === 'granted') {
    const n = new Notification(
      isRePing ? '⚠️ Approval Still Pending' : '🔔 Action Approval Needed',
      {
        body: `Truth needs your approval for: ${tool}`,
        tag: 'truth-approval', // replaces previous notification
        requireInteraction: true,
      }
    );
    n.onclick = () => {
      window.focus();
      n.close();
    };
  }
}

let titleFlashInterval: ReturnType<typeof setInterval> | null = null;
const ORIGINAL_TITLE = typeof document !== 'undefined' ? document.title : 'Truth';

/** Flash the tab title to attract attention */
function startTitleFlash(tool: string) {
  if (titleFlashInterval) return; // Already flashing
  let isAlert = true;
  titleFlashInterval = setInterval(() => {
    document.title = isAlert ? `⚠️ APPROVAL NEEDED — ${tool}` : ORIGINAL_TITLE;
    isAlert = !isAlert;
  }, 1000);
}

function stopTitleFlash() {
  if (titleFlashInterval) {
    clearInterval(titleFlashInterval);
    titleFlashInterval = null;
    document.title = ORIGINAL_TITLE;
  }
}

/** Send 'seen' acknowledgment to backend */
async function sendSeenAcknowledgment(approvalId: string) {
  try {
    await fetch('/api/mcp/approve/seen', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approvalId }),
    });
  } catch {
    // Best effort — don't block the UI
  }
}

export default function ChatClient() {
  const navigate = useNavigate();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [inputVal, setInputVal] = useState('');
  const [config, setConfig] = useState<{ baseModel: string } | null>(null);
  const [mode, setMode] = useState<'compare' | 'shared' | 'team' | 'solo'>('compare');
  const [sharedModel, setSharedModel] = useState<string>('gemini');
  const [topic, setTopic] = useState('DEV');
  const [historyFilter, setHistoryFilter] = useState<string | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [isTyping, setIsTyping] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [showAudit, setShowAudit] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [activeRightTab, setActiveRightTab] = useState<'workspace' | 'mcp' | 'integrations'>('integrations');
  const [conversationId, setConversationId] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [currentUser, setCurrentUser] = useState<any>(null);
  const [modelConfigs, setModelConfigs] = useState<ModelConfigs>({
    gemini: 'gemini-3.5-flash',
    chatgpt: 'gpt-5.5',
    claude: 'claude-opus-4-8',
    grok: 'grok-4.3',
    deepseek: 'deepseek-v3.2-maas',
    codex: 'gpt-5.5',
  });
  const [replyTargetModel, setReplyTargetModel] = useState<string | null>(null);
  const [pendingApproval, setPendingApproval] = useState<{ approvalId: string; tool: string; args: any } | null>(null);
  const [codexResponseId, setCodexResponseId] = useState<string | null>(null);

  // ── Approval notification effects ──────────────────────────────────────────

  // Request notification permission on first user interaction
  useEffect(() => {
    const handler = () => {
      requestNotificationPermission();
      document.removeEventListener('click', handler);
    };
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, []);

  // When approval arrives: play sound, send browser notification, flash title
  useEffect(() => {
    if (pendingApproval) {
      playApprovalSound();

      // If tab is hidden, send OS notification
      if (document.hidden) {
        sendBrowserNotification(pendingApproval.tool);
      }

      startTitleFlash(pendingApproval.tool);

      // Send 'seen' acknowledgment immediately if tab is visible,
      // otherwise wait for the user to focus the tab
      if (!document.hidden) {
        sendSeenAcknowledgment(pendingApproval.approvalId);
      } else {
        const onFocus = () => {
          sendSeenAcknowledgment(pendingApproval.approvalId);
          document.removeEventListener('visibilitychange', onFocus);
        };
        document.addEventListener('visibilitychange', onFocus);
      }
    } else {
      // Approval cleared — stop flashing
      stopTitleFlash();
    }
  }, [pendingApproval]);
  const [secretInputValue, setSecretInputValue] = useState('');
  const [isSubmittingSecret, setIsSubmittingSecret] = useState(false);
  const [workspaceSubTab, setWorkspaceSubTab] = useState<'google' | 'git'>('git');
  const [selectedProviders, setSelectedProviders] = useState<string[]>(['gemini', 'chatgpt', 'claude']);

  const [errorToast, setErrorToast] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const {
    attachments,
    isDragging,
    removeAttachment,
    clearAttachments,
    dragProps,
    pasteProps,
    fileInputProps,
  } = useFileAttachment({
    maxFileSize: 5 * 1024 * 1024, // 5MB limit
    maxFiles: 5,                  // Max 5 attachments
    acceptedTypes: ['image/*', 'application/pdf', '.csv', '.xlsx', '.js', '.ts', '.json'],
    onError: (err: FileAttachmentError) => {
      setErrorToast(err.message);
    },
  });

  useEffect(() => {
    if (errorToast) {
      const timer = setTimeout(() => setErrorToast(null), 4000);
      return () => clearTimeout(timer);
    }
  }, [errorToast]);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
    }
  }, [inputVal]);

  const handleUXApprovalDecision = async (approved: boolean) => {
    if (!pendingApproval) return;
    try {
      await fetch('/api/mcp/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          approvalId: pendingApproval.approvalId,
          approved
        })
      });
    } catch (err) {
      console.error("Failed to submit tool approval decision", err);
    } finally {
      setPendingApproval(null);
    }
  };

  const handleSecretSubmission = async () => {
    if (!pendingApproval || !secretInputValue.trim()) return;
    setIsSubmittingSecret(true);
    try {
      // 1. Vault the secret
      const res = await fetch('/api/vault/set', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: pendingApproval.args.secretId,
          value: secretInputValue.trim()
        })
      });
      if (!res.ok) throw new Error('Failed to vault secret');

      // 2. Approve the tool execution
      await handleUXApprovalDecision(true);
      setSecretInputValue('');
    } catch (err) {
      console.error(err);
      setErrorToast("Failed to vault secret securely.");
    } finally {
      setIsSubmittingSecret(false);
    }
  };

  useEffect(() => {
    const unsub = initAuth(async (user, token) => {
      // Fetch user role from Firestore
      try {
        const userDocRef = doc(db, 'users', user.uid);
        const userDoc = await getDoc(userDocRef);
        if (userDoc.exists()) {
          const userData = userDoc.data();
          setCurrentUser({ ...user, role: userData?.role || 'Admin' });
          if (userData?.modelConfigs) {
            setModelConfigs(prev => ({ ...prev, ...userData.modelConfigs }));
          }
        } else {
          setCurrentUser({ ...user, role: 'Admin' });
        }
      } catch (e) {
        console.error("Failed to fetch user doc", e);
        setCurrentUser({ ...user, role: 'Admin' });
      }

      const saved = sessionStorage.getItem('truthConfig');
      if (saved) {
        const parsed = JSON.parse(saved);
        setConfig(parsed);
        setSharedModel(parsed.baseModel);
      } else {
        setConfig({ baseModel: 'gemini' });
      }
    }, () => {
      navigate('/onboarding');
    });
    return () => unsub();
  }, [navigate]);

  useEffect(() => {
    if (!currentUser) return;
    const q = query(
      collection(db, 'users', currentUser.uid, 'conversations'),
      orderBy('updatedAt', 'desc'),
      limit(50)
    );
    const unsub = onSnapshot(q, (snapshot) => {
      const convs: Conversation[] = [];
      snapshot.forEach(d => {
        const data = d.data();
        convs.push({
          id: d.id,
          title: data.title || 'New Conversation',
          mode: data.mode,
          topic: data.topic,
          updatedAt: data.updatedAt
        });
      });
      setConversations(convs);
    }, (err) => {
      console.error('Firestore conversations listener error:', err);
    });
    return () => unsub();
  }, [currentUser]);

  const loadConversation = async (convId: string) => {
    if (!currentUser) return;
    setTurns([]);
    setConversationId(convId);
    if (showMenu) setShowMenu(false);

    const conv = conversations.find(c => c.id === convId);
    if (conv) {
      setTopic(conv.topic || 'Normal');
      if (['compare', 'shared', 'team', 'solo'].includes(conv.mode)) {
        setMode(conv.mode as 'compare' | 'shared' | 'team' | 'solo');
      }
    }

    try {
      const turnsQuery = query(
        collection(db, 'users', currentUser.uid, 'conversations', convId, 'turns'),
        orderBy('createdAt', 'asc')
      );
      const snapshot = await getDocs(turnsQuery);
      const loadedTurns: Turn[] = [];
      snapshot.forEach(d => {
        const data = d.data();
        loadedTurns.push({
          id: data.createdAt?.toMillis() || Date.now() + Math.random(),
          prompt: data.prompt,
          responses: data.responses,
          targeted: data.targeted || []
        });
      });
      setTurns(loadedTurns);
    } catch (err) {
      console.error("Failed to load turns", err);
    }
  };

  const deleteConversation = async (convId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const confirm = window.confirm("Delete this conversation?");
    if (!confirm || !currentUser) return;

    try {
      await deleteDoc(doc(db, 'users', currentUser.uid, 'conversations', convId));
      if (conversationId === convId) {
        setConversationId(null);
        setTurns([]);
      }
    } catch (err) {
      console.error("Failed to delete conversation", err);
    }
  };

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [turns]);

  const handleSend = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if ((!inputVal.trim() && attachments.length === 0) || isTyping || !config || !currentUser) return;

    const userText = inputVal.trim();
    setInputVal('');

    const filesPayload = attachments.map(att => ({
      name: att.name,
      size: att.size,
      type: att.type,
      dataUrl: att.dataUrl
    }));
    clearAttachments();

    const currentTarget = replyTargetModel
      ? [replyTargetModel]
      : mode === 'team'
        ? ['planner', 'ui_engineer', 'data_analyst']
        : mode === 'shared'
          ? [sharedModel]
          : selectedProviders;

    const turnId = Date.now();
    setTurns(prev => [...prev, {
      id: turnId,
      prompt: userText,
      responses: null,
      targeted: currentTarget,
      attachments: filesPayload.map(f => ({ name: f.name, size: f.size, type: f.type }))
    }]);
    setIsTyping(true);
    setReplyTargetModel(null);

    // Log Audit action
    logAuditAction(currentUser, 'QUERY', { topic, mode, targetedModels: currentTarget, promptLength: userText.length, attachmentsCount: filesPayload.length });

    let activeConvId = conversationId;
    try {
      if (!activeConvId) {
        const newConvRef = doc(collection(db, 'users', currentUser.uid, 'conversations'));
        await setDoc(newConvRef, {
          userId: currentUser.uid,
          title: userText.substring(0, 40) + (userText.length > 40 ? '...' : ''),
          mode: mode,
          topic: topic,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        });
        activeConvId = newConvRef.id;
        setConversationId(activeConvId);
      } else {
        await updateDoc(doc(db, 'users', currentUser.uid, 'conversations', activeConvId), {
          updatedAt: serverTimestamp()
        });
      }
    } catch (err) {
      console.error("Firestore error creating conversation", err);
    }

    try {
      const activeModel = replyTargetModel || (mode === 'shared' ? sharedModel : null);
      const history = activeModel ? turns.map(t => {
        return [
          { role: 'user', content: t.prompt },
          { role: 'assistant', content: (t.responses as any)?.[activeModel] || '' }
        ];
      }).flat() : undefined;

      const targetModels = currentTarget;
      const accessToken = await getAccessToken();

      let parsedMcpServers: any[] = [];
      const mcpSaved = localStorage.getItem('mcp_full_servers');
      if (mcpSaved) {
        try {
          parsedMcpServers = JSON.parse(mcpSaved);
        } catch (e) {
          console.error("Failed to parse local MCP servers", e);
        }
      }
      // Merge missing preloaded servers (e.g. newly added tools like Spanner) into parsedMcpServers
      PRELOADED_SERVERS.forEach(pre => {
        const existing = parsedMcpServers.find(p => p.id === pre.id);
        if (!existing) {
          parsedMcpServers.push(pre);
        } else if (existing.type === 'Official') {
          // ensure the tools definition and commandOrUrl are updated to latest for official tools
          existing.tools = pre.tools;
          existing.commandOrUrl = pre.commandOrUrl;
        }
      });

      let parsedIntegrations: any[] = [];
      const apiSaved = localStorage.getItem('api_hub_integrations');
      if (apiSaved) {
        try {
          parsedIntegrations = JSON.parse(apiSaved);
        } catch (e) {
          console.error("Failed to parse local API integrations", e);
        }
      }

      // Detect if Codex is among the targeted models
      const hasCodex = targetModels.includes('codex');
      const codexOnly = hasCodex && targetModels.length === 1;
      let finalResponses = createEmptyResponses();
      targetModels.forEach(m => {
        finalResponses[m] = '';
      });
      let hasFinalResponses = false;

      const appendResponseText = (model: string, text: string) => {
        if (!text) return;
        finalResponses = {
          ...finalResponses,
          [model]: `${finalResponses[model] || ''}${text}`,
        };
        hasFinalResponses = true;

        const nextResponses = finalResponses;
        setTurns(prev => prev.map(t =>
          t.id === turnId ? { ...t, responses: nextResponses } : t
        ));
      };

      const appendCodexStreamError = (payload: unknown) => {
        appendResponseText('codex', formatCodexStreamError(payload));
      };

      // If Codex is the only target, route to the Codex handler.
      // If mixed (codex + other models), send to default handler AND codex handler.
      // The default handler ignores 'codex' in targetModels (it doesn't know that provider).
      const chatEndpoint = codexOnly ? '/api/truth/codex/chat' : '/api/truth/chat';

      const res = await fetch(chatEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream'
        },
        body: codexOnly
          ? JSON.stringify({
              prompt: userText,
              history,
              connectionId: conversationId,
              userTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
              modelVersion: modelConfigs.codex || 'gpt-5.5',
              ...(codexResponseId ? { previousResponseId: codexResponseId } : {}),
            })
          : JSON.stringify({
              prompt: userText,
              history,
              mode,
              targetModels,
              topic,
              googleAccessToken: accessToken,
              modelConfigs,
              mcpServers: parsedMcpServers,
              apiIntegrations: parsedIntegrations,
              attachments: filesPayload
            })
      });

      // If we have codex AND other models, also fire the codex handler in parallel
      if (hasCodex && !codexOnly) {
        fetch('/api/truth/codex/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
          body: JSON.stringify({
            prompt: userText,
            history,
            connectionId: conversationId,
            userTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            modelVersion: modelConfigs.codex || 'gpt-5.5',
            ...(codexResponseId ? { previousResponseId: codexResponseId } : {}),
          }),
        }).then(async (codexRes) => {
          if (!codexRes.ok || !codexRes.body) {
            appendCodexStreamError({ message: `Codex stream failed with HTTP ${codexRes.status}` });
            return;
          }
          const codexReader = codexRes.body.getReader();
          const codexDecoder = new TextDecoder('utf-8');
          let codexBuf = '';
          while (true) {
            const { done, value } = await codexReader.read();
            if (done) break;
            codexBuf += codexDecoder.decode(value, { stream: true });
            const cParts = codexBuf.split(/\r?\n\r?\n/);
            codexBuf = cParts.pop() || '';
            for (const part of cParts) {
              const lines = part.split(/\r?\n/);
              const evtLine = lines.find(l => l.startsWith('event: '));
              const datLine = lines.find(l => l.startsWith('data: '));
              if (!evtLine || !datLine) continue;
              const evtName = evtLine.substring(7).trim();
              const datStr = datLine.substring(6).trim();
              if (evtName === 'error') {
                appendCodexStreamError(datStr);
                continue;
              }

              try {
                const d = JSON.parse(datStr);
                if (evtName === 'delta' && d.text) {
                  appendResponseText('codex', d.text);
                } else if (evtName === 'citations' && d.annotations?.length > 0) {
                  const footnotes = '\n\n---\n**Sources:**\n' +
                    d.annotations.map((a: any, i: number) => `${i + 1}. [${a.title || a.url}](${a.url})`).join('\n');
                  appendResponseText('codex', footnotes);
                } else if (evtName === 'codex_response_id' && d.responseId) {
                  setCodexResponseId(d.responseId);
                } else if (evtName === 'tool_call_started') {
                  setTurns(prev => prev.map(t => {
                    if (t.id === turnId) {
                      const newEntry: ToolTraceEntry = {
                        id: d.callId || `codex-cmp-${Date.now()}`,
                        tool: d.tool,
                        model: 'codex',
                        status: 'running',
                        argsPreview: d.args ? JSON.stringify(d.args, null, 2) : undefined,
                        startedAt: Date.now(),
                      };
                      return { ...t, trace: [...(t.trace || []), newEntry] };
                    }
                    return t;
                  }));
                } else if (evtName === 'tool_call_completed') {
                  setTurns(prev => prev.map(t => {
                    if (t.id === turnId && t.trace) {
                      const updatedTrace = [...t.trace];
                      for (let i = updatedTrace.length - 1; i >= 0; i--) {
                        if (updatedTrace[i].id === d.callId || (updatedTrace[i].tool === d.tool && updatedTrace[i].status === 'running' && updatedTrace[i].model === 'codex')) {
                          updatedTrace[i] = { ...updatedTrace[i], status: 'success', elapsedMs: Date.now() - (updatedTrace[i].startedAt || Date.now()), resultPreview: d.result?.slice?.(0, 200) };
                          break;
                        }
                      }
                      return { ...t, trace: updatedTrace };
                    }
                    return t;
                  }));
                }
              } catch {}
            }
          }
        }).catch((err) => {
          appendCodexStreamError({
            message: err instanceof Error ? err.message : 'Codex stream failed to start.',
          });
        });
      }

      if (!res.ok || !res.body) {
        throw new Error(`HTTP error! status: ${res.status}`);
      }

      // Initialize responses state with empty strings for targeted models to show typing UI immediately
      setTurns(prev => prev.map(t => {
        if (t.id === turnId) {
          const initRes: any = { gemini: null, chatgpt: null, claude: null, grok: null, deepseek: null, codex: null };
          targetModels.forEach(m => initRes[m] = '');
          return { ...t, responses: initRes as Responses };
        }
        return t;
      }));

      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split(/\r?\n\r?\n/);
        buffer = parts.pop() || ''; // keep the last partial piece

        for (const part of parts) {
          const lines = part.split(/\r?\n/);
          const eventLine = lines.find(l => l.startsWith('event: '));
          const dataLine = lines.find(l => l.startsWith('data: '));

          if (!eventLine || !dataLine) continue;

          const eventName = eventLine.substring(7).trim();
          const dataStr = dataLine.substring(6).trim();

          // ── Codex-specific SSE events ─────────────────────────────
          if (eventName === 'delta') {
            try {
              const data = JSON.parse(dataStr);
              if (data.model === 'codex' && data.text) {
                appendResponseText('codex', data.text);
              }
            } catch (e) { }
          } else if (eventName === 'citations') {
            // Codex citation annotations — append as markdown footnotes
            try {
              const data = JSON.parse(dataStr);
              if (data.annotations?.length > 0) {
                const footnotes = '\n\n---\n**Sources:**\n' +
                  data.annotations.map((a: any, i: number) => `${i + 1}. [${a.title || a.url}](${a.url})`).join('\n');
                appendResponseText('codex', footnotes);
              }
            } catch (e) { }
          } else if (eventName === 'tool_call_started') {
            // Codex tool trace
            try {
              const data = JSON.parse(dataStr);
              setTurns(prev => prev.map(t => {
                if (t.id === turnId) {
                  const newEntry: ToolTraceEntry = {
                    id: data.callId || `codex-${Date.now()}`,
                    tool: data.tool,
                    model: 'codex',
                    status: 'running',
                    argsPreview: data.args ? JSON.stringify(data.args, null, 2) : undefined,
                    startedAt: Date.now(),
                  };
                  return { ...t, trace: [...(t.trace || []), newEntry] };
                }
                return t;
              }));
            } catch (e) { }
          } else if (eventName === 'tool_call_completed') {
            try {
              const data = JSON.parse(dataStr);
              setTurns(prev => prev.map(t => {
                if (t.id === turnId && t.trace) {
                  const updatedTrace = [...t.trace];
                  for (let i = updatedTrace.length - 1; i >= 0; i--) {
                    if (updatedTrace[i].id === data.callId || (updatedTrace[i].tool === data.tool && updatedTrace[i].status === 'running')) {
                      updatedTrace[i] = { ...updatedTrace[i], status: 'success', elapsedMs: Date.now() - (updatedTrace[i].startedAt || Date.now()), resultPreview: data.result?.slice?.(0, 200) };
                      break;
                    }
                  }
                  return { ...t, trace: updatedTrace };
                }
                return t;
              }));
            } catch (e) { }
          } else if (eventName === 'codex_response_id') {
            // Track response ID for multi-turn Codex state
            try {
              const data = JSON.parse(dataStr);
              if (data.responseId) {
                setCodexResponseId(data.responseId);
              }
            } catch (e) { }
          } else if (eventName === 'code_delta') {
            // Live code execution preview from code_interpreter
            try {
              const data = JSON.parse(dataStr);
              if (data.code) {
                setTurns(prev => prev.map(t => {
                  if (t.id === turnId && t.trace) {
                    const updatedTrace = [...t.trace];
                    for (let i = updatedTrace.length - 1; i >= 0; i--) {
                      if (updatedTrace[i].tool === 'code_interpreter' && updatedTrace[i].status === 'running') {
                        updatedTrace[i] = {
                          ...updatedTrace[i],
                          resultPreview: (updatedTrace[i].resultPreview || '') + data.code,
                        };
                        break;
                      }
                    }
                    return { ...t, trace: updatedTrace };
                  }
                  return t;
                }));
              }
            } catch (e) { }
          } else if (eventName === 'tool_progress') {
            // Tool execution status updates (searching, executing, etc.)
            try {
              const data = JSON.parse(dataStr);
              setTurns(prev => prev.map(t => {
                if (t.id === turnId && t.trace) {
                  const updatedTrace = [...t.trace];
                  for (let i = updatedTrace.length - 1; i >= 0; i--) {
                    if (updatedTrace[i].id === data.callId && updatedTrace[i].status === 'running') {
                      updatedTrace[i] = { ...updatedTrace[i], resultPreview: data.status };
                      break;
                    }
                  }
                  return { ...t, trace: updatedTrace };
                }
                return t;
              }));
            } catch (e) { }
          } else if (eventName === 'codex_turn_completed') {
            // Codex turn complete — log usage for cost tracking
            try {
              const data = JSON.parse(dataStr);
              console.log('[Codex] Turn completed', data.usage);
            } catch (e) { }
          } else if (eventName === 'message') {
            try {
              const data = JSON.parse(dataStr);
              if (data.model && data.chunk) {
                appendResponseText(data.model, data.chunk);
              }
            } catch (e) { }
          } else if (eventName === 'error') {
            if (codexOnly) {
              appendCodexStreamError(dataStr);
            } else {
              console.error("SSE Error:", dataStr);
            }
          } else if (eventName === 'tool_approval_required') {
            try {
              const data = JSON.parse(dataStr);
              if (data.approvalId && data.tool) {
                setPendingApproval({
                  approvalId: data.approvalId,
                  tool: data.tool,
                  args: data.args
                });
              }
            } catch (e) { }
          } else if (eventName === 'tool_approval_reping') {
            // Re-ping: the backend is reminding us about an unacknowledged approval
            try {
              const data = JSON.parse(dataStr);
              playApprovalSound();
              if (document.hidden) {
                sendBrowserNotification(data.tool || 'unknown tool', true);
              }
            } catch (e) { }
          } else if (eventName === 'tool_start') {
            // ── Trace: new tool call started ──
            try {
              const data = JSON.parse(dataStr);
              setTurns(prev => prev.map(t => {
                if (t.id === turnId) {
                  const newEntry: ToolTraceEntry = {
                    id: `${data.tool}-${Date.now()}`,
                    tool: data.tool,
                    model: data.model || '',
                    status: 'running',
                    argsPreview: data.argsPreview ? (typeof data.argsPreview === 'string' ? data.argsPreview : JSON.stringify(data.argsPreview, null, 2)) : undefined,
                    startedAt: Date.now(),
                  };
                  return { ...t, trace: [...(t.trace || []), newEntry] };
                }
                return t;
              }));
            } catch (e) { }
          } else if (eventName === 'tool_progress') {
            // ── Trace: update elapsed time ──
            try {
              const data = JSON.parse(dataStr);
              setTurns(prev => prev.map(t => {
                if (t.id === turnId && t.trace) {
                  const updatedTrace = [...t.trace];
                  for (let i = updatedTrace.length - 1; i >= 0; i--) {
                    if (updatedTrace[i].tool === data.tool && updatedTrace[i].status === 'running') {
                      updatedTrace[i] = { ...updatedTrace[i], elapsedMs: data.elapsedMs };
                      break;
                    }
                  }
                  return { ...t, trace: updatedTrace };
                }
                return t;
              }));
            } catch (e) { }
          } else if (eventName === 'tool_result') {
            // ── Trace: tool completed + email persistence ──
            try {
              const data = JSON.parse(dataStr);
              // Update trace entry to success
              setTurns(prev => prev.map(t => {
                if (t.id === turnId && t.trace) {
                  const updatedTrace = [...t.trace];
                  for (let i = updatedTrace.length - 1; i >= 0; i--) {
                    if (updatedTrace[i].tool === data.tool && updatedTrace[i].status === 'running') {
                      updatedTrace[i] = {
                        ...updatedTrace[i],
                        status: 'success',
                        elapsedMs: data.elapsedMs,
                        resultPreview: data.resultPreview ? (typeof data.resultPreview === 'string' ? data.resultPreview : JSON.stringify(data.resultPreview)) : undefined,
                      };
                      break;
                    }
                  }
                  return { ...t, trace: updatedTrace };
                }
                return t;
              }));
              // Email persistence (existing behavior)
              if (data.tool === 'sendEmail' || data.tool === 'send_email_draft' || data.tool === 'send_email') {
                if (currentUser) {
                  const emailsCol = collection(db, 'users', currentUser.uid, 'emails');
                  await addDoc(emailsCol, {
                    type: 'ai_tool',
                    tool: data.tool,
                    model: data.model,
                    result: data.result,
                    timestamp: serverTimestamp()
                  });
                }
              }
            } catch (e) { }
          } else if (eventName === 'tool_error') {
            // ── Trace: tool failed ──
            try {
              const data = JSON.parse(dataStr);
              setTurns(prev => prev.map(t => {
                if (t.id === turnId && t.trace) {
                  const updatedTrace = [...t.trace];
                  for (let i = updatedTrace.length - 1; i >= 0; i--) {
                    if (updatedTrace[i].tool === data.tool && updatedTrace[i].status === 'running') {
                      updatedTrace[i] = {
                        ...updatedTrace[i],
                        status: 'error',
                        elapsedMs: data.elapsedMs,
                        error: data.error || 'Tool execution failed',
                      };
                      break;
                    }
                  }
                  return { ...t, trace: updatedTrace };
                }
                return t;
              }));
            } catch (e) { }
          }
        }
      }

      // Wait for React state to settle or just use tracked finalResponses
      if (activeConvId && hasFinalResponses) {
        try {
          const turnRef = doc(collection(db, 'users', currentUser.uid, 'conversations', activeConvId, 'turns'));
          await setDoc(turnRef, {
            prompt: userText,
            responses: finalResponses,
            targeted: currentTarget,
            createdAt: serverTimestamp()
          });
        } catch (err) {
          console.error("Firestore error saving turn", err);
        }
      }

      // ── Generate Suggested Follow-ups (fire-and-forget) ──
      if (hasFinalResponses) {
        const firstResponse = (Object.values(finalResponses) as string[]).find(v => v && v.length > 0) || '';
        fetch('/api/truth/suggest', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            lastPrompt: userText,
            lastResponse: firstResponse,
            topic,
          }),
        })
          .then(r => r.json())
          .then(data => {
            if (data.suggestions && data.suggestions.length > 0) {
              setTurns(prev => prev.map(t =>
                t.id === turnId ? { ...t, suggestions: data.suggestions } : t
              ));
            }
          })
          .catch(() => {}); // Silent fail — suggestions are non-critical
      }

    } catch (err) {
      console.error('[ChatClient] Stream error:', err);
      const errorMessage = err instanceof Error
        ? `Connection error: ${err.message}`
        : 'Connection error: unknown failure';
      const errorResponses = createEmptyResponses();
      currentTarget.forEach(model => {
        errorResponses[model] = errorMessage;
      });
      setTurns(prev => prev.map(t =>
        t.id === turnId ? {
          ...t,
          responses: errorResponses,
        } : t
      ));
    } finally {
      setIsTyping(false);
    }
  };

  if (!config) return null;

  const getModelDisplayName = (id: string) => {
    const version = modelConfigs[id as keyof ModelConfigs] || '';
    if (id === 'gemini') {
      if (version === 'gemini-3.5-flash') return 'Gemini 3.5 Flash';
      if (version === 'gemini-3.5-flash-puppeteer') return 'Gemini 3.5 Flash (Puppeteer)';
      if (version === 'gemini-3.1-pro-preview') return 'Gemini 3.1 Pro';
      if (version === 'gemini-3.1-pro-preview-next') return 'Gemini 3.1 Pro Preview Next (Deep Think)';
      if (version === 'gemini-3.1-pre-preview') return 'Gemini 3.1 Pre-Preview (Deep Think)';
      if (version === 'gemini-3.1-flash-lite') return 'Gemini 3.1 Lite';
      return `Gemini (${version})`;
    }
    if (id === 'chatgpt') {
      if (version === 'gpt-5.5') return 'ChatGPT 5.5';
      if (version === 'gpt-5.4') return 'ChatGPT 5.4';
      if (version === 'gpt-5.4-mini') return 'ChatGPT 5.4 Mini';
      if (version === 'gpt-5.4-nano') return 'ChatGPT 5.4 Nano';
      return `ChatGPT (${version})`;
    }
    if (id === 'claude') {
      if (version === 'claude-opus-4-8') return 'Claude Opus 4.8';
      if (version === 'claude-opus-4-6') return 'Claude Opus 4.6';
      if (version === 'claude-sonnet-4-6') return 'Claude Sonnet 4.6';
      return `Claude (${version})`;
    }
    if (id === 'grok') {
      if (version === 'grok-4.3') return 'Grok 4.3';
      if (version === 'grok-4.20-reasoning') return 'Grok 4.20 Reasoning';
      if (version === 'grok-4.20-non-reasoning') return 'Grok 4.20 Fast';
      if (version === 'grok-4.1-fast-reasoning') return 'Grok 4.1 Fast';
      return `Grok (${version})`;
    }
    if (id === 'deepseek') {
      if (version === 'deepseek-v3.2-maas') return 'DeepSeek V3.2';
      if (version === 'deepseek-r1-0528-maas') return 'DeepSeek R1';
      if (version === 'deepseek-v3.1-maas') return 'DeepSeek V3.1';
      if (version === 'deepseek-ocr-maas') return 'DeepSeek OCR';
      return `DeepSeek (${version})`;
    }
    if (id === 'codex') {
      if (version === 'gpt-5.5') return 'Codex GPT-5.5';
      if (version === 'gpt-5.4') return 'Codex GPT-5.4';
      if (version === 'gpt-5.4-mini') return 'Codex GPT-5.4 Mini';
      return `Codex (${version})`;
    }
    if (id === 'planner') return 'Planner';
    if (id === 'ui_engineer') return 'UI Engineer';
    if (id === 'data_analyst') return 'Data Analyst';
    return id;
  };

  const renderModelCard = (id: string, name: string, content: string | null, showReplySolo: boolean = false) => {
    const isBase = config.baseModel === id;
    const isErrorOrMissing = content?.includes('Configure') || content?.includes('Error');
    const version = modelConfigs[id as keyof ModelConfigs] || '';

    const displayName = getModelDisplayName(id);

    return (
      <div className={`bg-white/[0.03] backdrop-blur-xl border text-left rounded-2xl p-6 flex flex-col h-full transition-all duration-300 ${isBase && mode !== 'team' ? 'border-white/20 ring-1 ring-white/10 shadow-[0_0_20px_rgba(255,255,255,0.04)]' : 'border-white/[0.06] hover:border-white/[0.12] hover:bg-white/[0.05]'}`}>
        <div className="font-serif font-medium text-white mb-4 border-b border-white/10 pb-3 flex items-center justify-between">
          <span className="flex items-center space-x-3">
            <span>{displayName}</span>
            {isBase && mode !== 'team' && <span className="text-[10px] bg-white text-black px-2 py-0.5 rounded-full uppercase tracking-[0.2em] font-sans font-bold shadow-[0_0_10px_rgba(255,255,255,0.2)]">Base</span>}
          </span>
          {content && !isErrorOrMissing && showReplySolo && (
            <button
              onClick={() => {
                setReplyTargetModel(id);
                const inputEl = document.querySelector('form input') as HTMLInputElement;
                inputEl?.focus();
              }}
              className="text-[10px] bg-zinc-900 hover:bg-zinc-800 border border-white/10 hover:border-white/20 text-zinc-400 hover:text-white px-2.5 py-1 rounded-full font-sans transition-all flex items-center space-x-1 cursor-pointer"
              title={`Reply to ${displayName} only`}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 17 4 12 9 7"></polyline><path d="M20 18v-2a4 4 0 0 0-4-4H4"></path></svg>
              <span>Reply Solo</span>
            </button>
          )}
        </div>
        <div className={`text-sm leading-relaxed overflow-hidden break-words flex-1 font-light ${isErrorOrMissing ? 'text-red-400 italic' : 'text-zinc-300'}`}>
          {content === null ? (
            <div className="flex space-x-1.5 items-center h-full opacity-50 py-2">
              <div className="w-1.5 h-1.5 rounded-full bg-white animate-bounce" style={{ animationDelay: '0ms' }} />
              <div className="w-1.5 h-1.5 rounded-full bg-white animate-bounce" style={{ animationDelay: '150ms' }} />
              <div className="w-1.5 h-1.5 rounded-full bg-white animate-bounce" style={{ animationDelay: '300ms' }} />
            </div>
          ) : (
            content ? <MimeRenderer content={content} /> : "No response."
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="flex flex-col h-screen bg-black text-white font-sans pb-safe pt-safe selection:bg-zinc-800 relative overflow-hidden">
      {/* Ambient depth — pure aura black, no color tints */}
      <div className="pointer-events-none fixed inset-0 z-0 overflow-hidden" aria-hidden="true">
        <div className="absolute -top-[40%] -left-[20%] w-[60vw] h-[60vw] rounded-full bg-white/[0.015] blur-[120px]" />
        <div className="absolute -bottom-[30%] -right-[10%] w-[50vw] h-[50vw] rounded-full bg-white/[0.01] blur-[120px]" />
      </div>
      {/* Header */}
      <header className="flex-shrink-0 px-6 py-4 border-b border-white/[0.08] bg-white/[0.03] backdrop-blur-2xl backdrop-saturate-150 flex justify-between items-center sticky top-0 z-20 w-full text-center sm:text-left">
        <div className="flex items-center space-x-4 flex-1">
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="p-2 -ml-2 text-zinc-400 hover:text-white transition-colors"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><line x1="3" y1="12" x2="21" y2="12"></line><line x1="3" y1="6" x2="21" y2="6"></line><line x1="3" y1="18" x2="21" y2="18"></line></svg>
          </button>
          <div className="flex items-center space-x-3 cursor-pointer" onClick={() => navigate('/')}>
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-white hidden sm:block"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg>
            <div>
              <h2 className="font-serif font-medium text-lg text-white tracking-tight leading-tight flex items-center gap-2">
                Truth.
              </h2>
            </div>
          </div>
        </div>

        <div className="hidden md:flex bg-white/[0.06] backdrop-blur-xl border border-white/[0.08] p-1 rounded-full text-xs font-semibold tracking-wide">
          <button
            onClick={() => setMode('compare')}
            className={`px-5 py-1.5 rounded-full transition-all duration-300 ${mode === 'compare' ? 'bg-white text-black shadow-sm' : 'text-zinc-400 hover:text-white'}`}
          >
            Compare
          </button>
          <button
            onClick={() => setMode('shared')}
            className={`px-5 py-1.5 rounded-full transition-all duration-300 ${mode === 'shared' ? 'bg-white text-black shadow-sm' : 'text-zinc-400 hover:text-white'}`}
          >
            Shared Context
          </button>
          <button
            onClick={() => setMode('team')}
            className={`px-5 py-1.5 rounded-full transition-all duration-300 ${mode === 'team' ? 'bg-white text-black shadow-sm' : 'text-zinc-400 hover:text-white'}`}
          >
            Team
          </button>
        </div>


        <div className="flex space-x-3 items-center relative flex-1 justify-end">
          {/* Workspace Button */}
          <button
            onClick={() => {
              if (workspaceOpen && activeRightTab === 'workspace') {
                setWorkspaceOpen(false);
              } else {
                setWorkspaceOpen(true);
                setActiveRightTab('workspace');
              }
            }}
            className={`flex items-center space-x-2 px-3 py-1.5 text-xs font-semibold uppercase tracking-wider rounded-full transition-all duration-300 border ${workspaceOpen && activeRightTab === 'workspace' ? 'bg-white text-black border-white shadow-[0_0_15px_rgba(255,255,255,0.1)]' : 'text-zinc-400 hover:text-white bg-white/5 hover:bg-white/10 border-transparent'}`}
            title="Workspace"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="7" width="20" height="14" rx="2" ry="2"></rect><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"></path></svg>
            <span className="hidden lg:inline">Workspace</span>
          </button>

          {/* MCP Registry Button */}
          <button
            onClick={() => {
              if (workspaceOpen && activeRightTab === 'mcp') {
                setWorkspaceOpen(false);
              } else {
                setWorkspaceOpen(true);
                setActiveRightTab('mcp');
              }
            }}
            className={`flex items-center space-x-2 px-3 py-1.5 text-xs font-semibold uppercase tracking-wider rounded-full transition-all duration-300 border ${workspaceOpen && activeRightTab === 'mcp' ? 'bg-white text-black border-white shadow-[0_0_15px_rgba(255,255,255,0.1)]' : 'text-zinc-400 hover:text-white bg-white/5 hover:bg-white/10 border-transparent'}`}
            title="MCP Registry"
          >
            <span className="flex h-2 w-2 relative">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
            </span>
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"></polygon><polyline points="2 17 12 22 22 17"></polyline><polyline points="2 12 12 17 22 12"></polyline></svg>
            <span className="hidden lg:inline">MCP Registry</span>
          </button>

          {/* Secrets Vault Button */}
          <button
            onClick={() => {
              if (workspaceOpen && activeRightTab === 'integrations') {
                setWorkspaceOpen(false);
              } else {
                setWorkspaceOpen(true);
                setActiveRightTab('integrations');
              }
            }}
            className={`flex items-center space-x-2 px-3 py-1.5 text-xs font-semibold uppercase tracking-wider rounded-full transition-all duration-300 border ${workspaceOpen && activeRightTab === 'integrations' ? 'bg-white text-black border-white shadow-[0_0_15px_rgba(255,255,255,0.1)]' : 'text-zinc-400 hover:text-white bg-white/5 hover:bg-white/10 border-transparent'}`}
            title="Secrets Vault"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path><path d="m9 12 2 2 4-4"></path></svg>
            <span className="hidden lg:inline">Secrets Vault</span>
          </button>

          <button onClick={() => setShowMenu(!showMenu)} className="p-2 text-zinc-400 hover:text-white transition-colors" title="Options">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="1"></circle><circle cx="12" cy="5" r="1"></circle><circle cx="12" cy="19" r="1"></circle></svg>
          </button>

          <AnimatePresence>
            {showMenu && (
              <motion.div
                initial={{ opacity: 0, scale: 0.95, y: -10 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95, y: -10 }}
                transition={{ duration: 0.15 }}
                className="absolute right-0 top-12 w-56 bg-zinc-950/80 backdrop-blur-2xl backdrop-saturate-150 border border-white/[0.08] rounded-2xl shadow-2xl shadow-black/40 overflow-hidden py-2 z-30"
              >
                {(currentUser?.role === 'Admin' || currentUser?.role === 'Editor') && (
                  <button
                    onClick={() => {
                      setShowExport(true);
                      setShowMenu(false);
                    }}
                    className="w-full text-left px-4 py-2.5 text-sm text-zinc-300 hover:bg-white/5 transition-colors"
                  >
                    Export Conversation
                  </button>
                )}
                {currentUser?.role === 'Admin' && (
                  <button
                    onClick={() => {
                      setShowAudit(true);
                      setShowMenu(false);
                    }}
                    className="w-full text-left px-4 py-2.5 text-sm text-zinc-300 hover:bg-white/5 transition-colors"
                  >
                    Enterprise Audit Logs
                  </button>
                )}
                <button
                  onClick={() => {
                    setShowSettings(true);
                    setShowMenu(false);
                  }}
                  className="w-full text-left px-4 py-2.5 text-sm text-zinc-300 hover:bg-white/5 transition-colors"
                >
                  Settings
                </button>
                <button
                  onClick={() => {
                    setConversationId(null);
                    setTurns([]);
                    setShowMenu(false);
                  }}
                  className="w-full text-left px-4 py-2.5 text-sm text-zinc-300 hover:bg-white/5 transition-colors"
                >
                  New Chat
                </button>
                <button
                  onClick={() => {
                    const confirm = window.confirm("Clear conversation history?");
                    if (confirm) {
                      setTurns([]);
                      setShowMenu(false);
                    }
                  }}
                  className="w-full text-left px-4 py-2.5 text-sm text-zinc-300 hover:bg-white/5 transition-colors"
                >
                  Clear History
                </button>
                <button
                  onClick={async () => {
                    const confirm = window.confirm("End session?");
                    if (confirm) {
                      try {
                        await signOut(auth);
                      } catch (e) {
                        console.error(e);
                      }
                      sessionStorage.removeItem('truthConfig');
                      navigate('/');
                    }
                  }}
                  className="w-full text-left px-4 py-2.5 text-sm text-red-400 hover:bg-red-500/10 transition-colors"
                >
                  End Session
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden relative">
        {/* Sidebar */}
        <AnimatePresence initial={false}>
          {sidebarOpen && (
            <motion.aside
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: 260, opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              className="border-r border-white/[0.06] bg-zinc-950/70 backdrop-blur-2xl backdrop-saturate-150 flex flex-col flex-shrink-0 overflow-hidden"
            >
              <div className="p-4 w-[260px] h-full flex flex-col">
                <button
                  onClick={() => {
                    setConversationId(null);
                    setTurns([]);
                  }}
                  className="w-full text-left px-4 py-3 rounded-xl text-sm font-medium transition-all duration-300 bg-white/5 hover:bg-white/10 text-white border border-white/10 flex items-center justify-between mb-6 group shadow-sm"
                >
                  <span>New Chat</span>
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="opacity-50 group-hover:opacity-100 transition-opacity"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
                </button>

                <div className="flex justify-between items-center mb-3 pr-2">
                  <h3 className="text-[10px] uppercase tracking-widest font-bold text-zinc-500 pl-2">History</h3>
                  <select 
                    className="bg-transparent text-[10px] text-zinc-500 uppercase tracking-wider focus:outline-none hover:text-zinc-300 cursor-pointer"
                    value={historyFilter || ''}
                    onChange={(e) => setHistoryFilter(e.target.value || null)}
                  >
                    <option value="">ALL DOMAINS</option>
                    {DOMAINS.map(d => (
                      <option key={d.id} value={d.id}>{d.id}</option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1 flex-1 overflow-y-auto pr-1 custom-scrollbar">
                  {conversations.filter(c => !historyFilter || c.topic === historyFilter).length === 0 ? (
                    <div className="text-zinc-600 text-xs px-2 py-4 italic">No matching threads</div>
                  ) : (
                    conversations.filter(c => !historyFilter || c.topic === historyFilter).map(c => {
                      const domainMeta = DOMAINS.find(d => d.id === c.topic) || DOMAINS.find(d => d.id === 'GENERAL') || { id: 'UNKNOWN', label: 'UNKNOWN', color: 'text-zinc-500 bg-zinc-500/10 border-zinc-500/20' };
                      const isActive = c.title.includes('ACTIVE');
                      const isBlocked = c.title.includes('BLOCKED');
                      const stateColor = isActive ? 'bg-emerald-500' : isBlocked ? 'bg-red-500' : 'bg-zinc-500';
                      
                      let displayTitle = c.title;
                      if (displayTitle.includes('TL;DR:')) {
                        displayTitle = displayTitle.split('TL;DR:')[1].trim();
                      } else if (displayTitle.includes('] ')) {
                        displayTitle = displayTitle.split('] ').pop() || displayTitle;
                      }

                      return (
                        <div
                          key={c.id}
                          onClick={() => loadConversation(c.id)}
                          className={`group w-full text-left px-3 py-2.5 rounded-xl text-sm transition-all duration-200 cursor-pointer flex flex-col gap-1.5 ${conversationId === c.id ? 'bg-white/10 text-white font-medium border border-white/5' : 'text-zinc-400 hover:text-white hover:bg-white/[0.03] border border-transparent'}`}
                        >
                          <div className="flex justify-between items-center">
                            <span className={`text-[9px] px-1.5 py-0.5 rounded-md border ${domainMeta.color} font-mono tracking-wider`}>
                              {domainMeta.id}
                            </span>
                            <div className="flex items-center gap-2">
                              <span className={`w-1.5 h-1.5 rounded-full ${stateColor} opacity-80`} title={isActive ? 'Active' : isBlocked ? 'Blocked' : 'Resolved'}></span>
                              <button
                                onClick={(e) => deleteConversation(c.id, e)}
                                className="opacity-0 group-hover:opacity-100 text-zinc-500 hover:text-red-400 transition-all rounded-md hover:bg-white/5 flex items-center justify-center"
                                title="Delete thread"
                              >
                                <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                              </button>
                            </div>
                          </div>
                          <span className="truncate w-full text-[12px] leading-relaxed text-zinc-300">{displayTitle}</span>
                        </div>
                      )
                    })
                  )}
                </div>

                <div className="mt-4 pt-4 border-t border-white/[0.06]">
                  <h3 className="text-[10px] uppercase tracking-widest font-bold text-zinc-500 mb-3 pl-2">Active Domain</h3>
                  <select
                    value={topic}
                    onChange={(e) => setTopic(e.target.value)}
                    className="w-full bg-zinc-900 border border-white/10 text-zinc-300 text-xs rounded-lg px-3 py-2 focus:outline-none focus:border-white/20"
                  >
                    {DOMAINS.map(d => (
                      <option key={d.id} value={d.id}>{d.label}</option>
                    ))}
                  </select>
                </div>
              </div>
            </motion.aside>
          )}
        </AnimatePresence>

        {/* Chat Area */}
        <main
          className="flex-1 overflow-y-auto px-4 py-10 flex flex-col space-y-12"
          onClick={() => showMenu && setShowMenu(false)}
        >
          <div className="max-w-[1400px] w-full mx-auto flex flex-col space-y-12">
            {turns.length === 0 && (
              <div className="m-auto text-center text-zinc-400 mt-20">
                <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-white/5 border border-white/10 mb-6">
                  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-white"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg>
                </div>
                <div className="font-serif text-3xl mb-3 text-white tracking-tight">Ready to start.</div>
                <p className="mb-8 font-light text-lg">Domain: <span className="font-semibold text-white">{topic}</span></p>
                <div className="md:hidden flex flex-wrap justify-center gap-2 bg-zinc-900 border border-white/10 p-1 rounded-2xl text-xs font-semibold mx-auto w-fit">
                  <button
                    onClick={() => setMode('compare')}
                    className={`px-4 py-1.5 rounded-full transition-colors ${mode === 'compare' ? 'bg-white text-black shadow-sm' : 'text-zinc-400 hover:text-white'}`}
                  >
                    Compare
                  </button>
                  <button
                    onClick={() => setMode('shared')}
                    className={`px-4 py-1.5 rounded-full transition-colors ${mode === 'shared' ? 'bg-white text-black shadow-sm' : 'text-zinc-400 hover:text-white'}`}
                  >
                    Shared Context
                  </button>
                  <button
                    onClick={() => setMode('solo')}
                    className={`px-4 py-1.5 rounded-full transition-colors ${mode === 'solo' ? 'bg-white text-black shadow-sm' : 'text-zinc-400 hover:text-white'}`}
                  >
                    Solo
                  </button>
                </div>
              </div>
            )}

            <AnimatePresence initial={false}>
              {turns.map((turn) => (
                <motion.div
                  key={turn.id}
                  initial={{ opacity: 0, y: 15 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
                  className="flex flex-col space-y-6"
                >
                  {/* User Prompt */}
                  <div className="flex justify-end relative">
                    <div className="absolute right-0 top-1/2 -translate-y-1/2 translate-x-full pl-4 opacity-0 lg:opacity-100 text-xs font-mono text-zinc-600">You</div>
                    <div className="max-w-[85%] sm:max-w-[60%] p-5 rounded-2xl leading-relaxed text-sm sm:text-base bg-white text-black rounded-tr-sm shadow-[0_0_20px_rgba(255,255,255,0.1)]">
                      <div>{turn.prompt}</div>
                      {turn.attachments && turn.attachments.length > 0 && (
                        <div className="mt-3 pt-3 border-t border-black/10 flex flex-wrap gap-1.5">
                          {turn.attachments.map((att, i) => (
                            <div key={i} className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-black/5 border border-black/10 text-xs font-mono text-black font-medium select-none">
                              <svg className="w-3.5 h-3.5 text-zinc-700 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M18.364 5.636l-3.536 3.536m0 0A3 3 0 1011.243 13.43l3.536-3.536m0 0L14.73 9.35M18.364 5.636a9 9 0 01-12.728 0m12.728 0L17.3 6.7m-11.664-.064a9 9 0 000 12.728m0 0l3.536-3.536m0 0l-1.129-1.13" />
                              </svg>
                              <span className="truncate max-w-[150px]" title={att.name}>{att.name}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Agentic Tool Trace */}
                  {turn.trace && turn.trace.length > 0 && (
                    <div className="max-w-[85%] sm:max-w-[60%]">
                      <ToolTrace entries={turn.trace} />
                    </div>
                  )}

                  {/* Model Responses Grid */}
                  <div className="relative group">
                    <div className="absolute left-0 top-6 -translate-x-full pr-4 opacity-0 lg:opacity-100 text-xs font-mono text-zinc-600 flex flex-col space-y-2 items-end">
                      <span>Models</span>
                      <button
                        onClick={() => {
                          const content = Object.values(turn.responses || {})
                            .filter(Boolean)
                            .join('\n\n---\n\n');
                          copyToClipboard(content);
                        }}
                        className="opacity-0 group-hover:opacity-100 transition-opacity bg-zinc-800 text-white px-2 py-1 rounded text-[10px] hover:bg-zinc-700"
                        title="Copy all responses"
                      >
                        Copy All
                      </button>
                    </div>
                    <div className={`grid gap-6 ${turn.targeted.length === 1 ? 'grid-cols-1 max-w-4xl mr-auto' : 'grid-cols-1 md:grid-cols-2 lg:grid-cols-4 xl:grid-cols-5'}`}>
                      {turn.targeted.includes("gemini") && renderModelCard("gemini", "Gemini 3.5 Flash", turn.responses?.gemini || null, turn.targeted.length > 1)}
                      {turn.targeted.includes("chatgpt") && renderModelCard("chatgpt", "ChatGPT (GPT-4o)", turn.responses?.chatgpt || null, turn.targeted.length > 1)}
                      {turn.targeted.includes("claude") && renderModelCard("claude", "Claude 3.7 Sonnet", turn.responses?.claude || null, turn.targeted.length > 1)}
                      {turn.targeted.includes("grok") && renderModelCard("grok", "Grok (xAI)", turn.responses?.grok || null, turn.targeted.length > 1)}
                      {turn.targeted.includes("deepseek") && renderModelCard("deepseek", "DeepSeek", turn.responses?.deepseek || null, turn.targeted.length > 1)}
                    </div>
                  </div>

                  {/* Suggested Follow-up Prompts */}
                  {turn.suggestions && turn.suggestions.length > 0 && (
                    <SuggestedPrompts
                      suggestions={turn.suggestions}
                      onSelect={(prompt, model) => {
                        setInputVal(prompt);
                        setSharedModel(model);
                        setMode('shared');
                        textareaRef.current?.focus();
                      }}
                    />
                  )}
                </motion.div>
              ))}
            </AnimatePresence>
            <div ref={messagesEndRef} className="h-4" />
          </div>
        </main>

        {/* Right Sidebar (Workspace & MCP Integrations) */}
        <AnimatePresence initial={false}>
          {workspaceOpen && (
            <motion.aside
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: 380, opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              className="border-l border-white/[0.06] bg-zinc-950/70 backdrop-blur-2xl backdrop-saturate-150 flex flex-col flex-shrink-0 overflow-hidden"
            >
              <div className="w-[380px] h-full flex flex-col">
                {activeRightTab === 'workspace' ? (
                  <div className="h-full flex flex-col overflow-hidden">
                    <WorkspaceModeToggle mode={workspaceSubTab} onToggle={setWorkspaceSubTab} />

                    <div className="flex-1 overflow-hidden">
                      {workspaceSubTab === 'git' ? (
                        <GitWorkspaceHub
                          currentUser={currentUser}
                          onInsertContext={(text) => {
                            setInputVal(prev => prev + (prev ? '\n\n' : '') + text);
                          }}
                        />
                      ) : (
                        <WorkspaceHub onInsertContext={(text) => {
                          setInputVal(prev => prev + (prev ? '\n\n' : '') + text);
                        }} />
                      )}
                    </div>
                  </div>
                ) : activeRightTab === 'mcp' ? (
                  <McpRegistry
                    onClose={() => setWorkspaceOpen(false)}
                    onInsertContext={(text) => {
                      setInputVal(prev => prev + (prev ? '\n\n' : '') + text);
                    }}
                  />
                ) : (
                  <CredentialVault
                    onClose={() => setWorkspaceOpen(false)}
                  />
                )}
              </div>
            </motion.aside>
          )}
        </AnimatePresence>
      </div>

      {/* Input Area */}
      <div className="p-6 bg-black/60 backdrop-blur-3xl backdrop-saturate-150 border-t border-white/[0.06] z-10 relative">
        <form
          onSubmit={handleSend}
          className={`max-w-4xl mx-auto w-full relative flex flex-col space-y-2.5 shadow-[0_0_30px_rgba(255,255,255,0.03)] rounded-2xl border transition-all duration-200 ${isDragging
              ? 'border-emerald-500 ring-2 ring-emerald-500/10 bg-emerald-950/20'
              : 'border-white/10 bg-zinc-900/60 focus-within:border-white/30'
            }`}
          {...dragProps}
        >
          {/* Hidden inputs to capture attachments */}
          <input
            type="file"
            ref={fileInputRef}
            className="hidden"
            {...fileInputProps}
          />

          {/* Drag and Drop State Overlay */}
          {isDragging && (
            <div className="absolute inset-0 z-50 flex flex-col items-center justify-center rounded-2xl bg-emerald-500/5 backdrop-blur-[1px] pointer-events-none border-2 border-dashed border-emerald-500/40">
              <svg className="w-10 h-10 text-emerald-500 animate-bounce mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 16.5V9.75m0 0l3 3m-3-3l-3 3M6.75 19.5a4.5 4.5 0 01-1.41-8.775 5.25 5.25 0 0110.233-2.33 3 3 0 013.758 3.848A3.752 3.752 0 0118 19.5H6.75z" />
              </svg>
              <p className="text-sm font-semibold text-emerald-400">Drop files here to attach</p>
            </div>
          )}

          {replyTargetModel && (
            <div className="flex items-center space-x-2 bg-zinc-900/60 border border-emerald-500/20 px-4 py-2 rounded-full w-fit text-xs text-zinc-300 animate-in fade-in slide-in-from-bottom-1 duration-200 mt-3 ml-3">
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-emerald-400"><polyline points="9 17 4 12 9 7"></polyline><path d="M20 18v-2a4 4 0 0 0-4-4H4"></path></svg>
              <span>Replying solo to <strong className="text-white">{getModelDisplayName(replyTargetModel)}</strong></span>
              <button
                type="button"
                onClick={() => setReplyTargetModel(null)}
                className="text-zinc-500 hover:text-white ml-2 font-bold cursor-pointer transition-colors"
                title="Cancel solo reply"
              >
                ✕
              </button>
            </div>
          )}

          {/* Attachment Preview Bar */}
          {attachments.length > 0 && (
            <div
              className="flex flex-wrap gap-2 p-3 border-b border-white/5 bg-black/10"
              role="list"
              aria-label="File attachments list"
            >
              {attachments.map((file) => (
                <FileChip
                  key={file.id}
                  id={file.id}
                  name={file.name}
                  size={file.size}
                  type={file.type}
                  onRemove={removeAttachment}
                />
              ))}
            </div>
          )}

          {/* Input control area */}
          <div className="flex items-start gap-2 p-3 min-h-[50px]">
            {/* Paperclip Button */}
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="p-3 text-zinc-500 hover:text-white hover:bg-white/5 rounded-full transition-colors flex-shrink-0"
              aria-label="Attach local files"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M18.364 5.636l-3.536 3.536m0 0A3 3 0 1011.243 13.43l3.536-3.536m0 0L14.73 9.35M18.364 5.636a9 9 0 01-12.728 0m12.728 0L17.3 6.7m-11.664-.064a9 9 0 000 12.728m0 0l3.536-3.536m0 0l-1.129-1.13" />
              </svg>
            </button>

            {/* Textarea */}
            <textarea
              ref={textareaRef}
              rows={1}
              value={inputVal}
              onChange={(e) => setInputVal(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSend(e);
                }
              }}
              placeholder={replyTargetModel ? `Type a message to ${getModelDisplayName(replyTargetModel)} only...` : mode === 'solo' ? "Type a message..." : "Type a message to prompt multiple models..."}
              className="flex-1 w-full text-sm resize-none bg-transparent border-0 outline-none p-2 focus:ring-0 text-white placeholder-zinc-500 leading-relaxed font-light min-h-[38px] max-h-[200px]"
              disabled={isTyping}
              {...pasteProps}
            />

            {/* Actions Toolbar on the Right */}
            <div className="flex items-center space-x-2 self-end pb-1 pr-1 flex-shrink-0">
              <button
                type="button"
                className="p-2.5 text-zinc-500 hover:text-white hover:bg-white/5 rounded-full transition-colors"
                title="Prompt Library"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"></path></svg>
              </button>

              {(mode === 'shared' || mode === 'compare') && (
                <ModelSelector
                  mode={mode}
                  activeProvider={sharedModel}
                  modelConfigs={modelConfigs}
                  selectedProviders={selectedProviders}
                  onSelectModel={(providerId, versionId) => {
                    setSharedModel(providerId);
                    setModelConfigs(prev => ({ ...prev, [providerId]: versionId }));
                    logAuditAction(currentUser, 'SWITCH_MODEL', { newModel: providerId, version: versionId, previousModel: sharedModel });
                  }}
                  onToggleCompare={(providerId) => {
                    setSelectedProviders(prev => {
                      if (prev.includes(providerId)) {
                        if (prev.length <= 2) return prev;
                        return prev.filter(p => p !== providerId);
                      }
                      if (prev.length >= 4) return prev;
                      return [...prev, providerId];
                    });
                  }}
                />
              )}

              <button
                type="submit"
                disabled={(!inputVal.trim() && attachments.length === 0) || isTyping}
                className="p-3 bg-white text-black rounded-full hover:scale-105 disabled:opacity-50 disabled:hover:scale-100 transition-all w-11 h-11 flex items-center justify-center shadow-md cursor-pointer"
              >
                {isTyping ? (
                  <div className="w-5 h-5 border-2 border-black/20 border-t-black rounded-full animate-spin" />
                ) : (
                  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
                )}
              </button>
            </div>
          </div>
        </form>
      </div>

      <AnimatePresence>
        {showExport && (
          <ExportDialog
            onClose={() => setShowExport(false)}
            turns={turns}
            topic={topic}
            currentUser={currentUser}
          />
        )}
        {showAudit && (
          <AuditDialog onClose={() => setShowAudit(false)} currentUser={currentUser} />
        )}
        {showSettings && (
          <SettingsDialog
            onClose={() => setShowSettings(false)} modelConfigs={modelConfigs} onUpdateModelConfigs={setModelConfigs}
            currentUser={currentUser}
            onUpdateRole={(newRole) => {
              setCurrentUser({ ...currentUser, role: newRole });
            }}
          />
        )}
        {pendingApproval && (() => {
          const getApprovalDetails = (tool: string, args: any) => {
            switch (tool) {
              case "write_staged_file":
                return {
                  badge: "UX Review Request",
                  title: "Stage File for Review",
                  description: `The AI model has requested to stage a file in Cloud Storage: ${args?.path || args?.objectName || ""}. Confirming this will write the staged file.`,
                  colorClass: "text-amber-500",
                  pingBg: "bg-amber-500"
                };
              case "execute_ddl":
                return {
                  badge: "Critical Schema Change",
                  title: "Modify Live Spanner Schema",
                  description: "The AI model has requested schema modifications (DDL) on Spanner. Confirming this will run DDL migration statements.",
                  colorClass: "text-rose-500",
                  pingBg: "bg-rose-500"
                };
              case "execute_sql":
                return {
                  badge: "Critical Database Write",
                  title: "Modify Live Spanner Rows",
                  description: "The AI model has requested executing database queries that modify live rows (DML). Confirming this will run write/update queries.",
                  colorClass: "text-rose-500",
                  pingBg: "bg-rose-500"
                };
              case "deploy_staged_mcp":
                return {
                  badge: "Production Deployment",
                  title: "Deploy Staged Code to Cloud Run",
                  description: "The AI model has requested redeploying the Reverie platform to Cloud Run. Confirming this triggers source-based builds.",
                  colorClass: "text-rose-500",
                  pingBg: "bg-rose-500"
                };
              case "write_storage_text": {
                const path = args?.objectName || args?.path || "";
                const isStaged = path.includes("staged") || path.includes("staged/specs") || path.includes("truth-artifacts");
                return {
                  badge: isStaged ? "UX Review Request" : "Storage Modification",
                  title: "Write Cloud Storage Object",
                  description: `The AI model has requested writing an object to Cloud Storage: ${args?.bucketName || ""}/${path}.`,
                  colorClass: isStaged ? "text-amber-500" : "text-rose-500",
                  pingBg: isStaged ? "bg-amber-500" : "bg-rose-500"
                };
              }
              case "request_human_secret":
                return {
                  badge: "Credential Required",
                  title: "AI Needs a Secret",
                  description: args?.reason || `The AI model has requested the secret: ${args?.secretId}. Provide it below to continue.`,
                  colorClass: "text-emerald-500",
                  pingBg: "bg-emerald-500"
                };
              default:
                return {
                  badge: "UX Approval Required",
                  title: "Sensitive Action Requested",
                  description: `The AI model has requested execution of ${tool}. Confirming this will execute the action.`,
                  colorClass: "text-rose-500",
                  pingBg: "bg-rose-500"
                };
            }
          };

          const details = getApprovalDetails(pendingApproval.tool, pendingApproval.args);

          return (
            <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50 p-4 animate-fade-in">
              <div className="bg-zinc-950 border border-zinc-900 rounded-2xl max-w-md w-full p-6 space-y-6 shadow-2xl scale-up-animation">
                <div className="space-y-2">
                  <div className={`flex items-center gap-2 ${details.colorClass} text-xs font-bold tracking-wider uppercase`}>
                    <span className={`h-2 w-2 ${details.pingBg} rounded-full animate-ping`} />
                    <span>{details.badge}</span>
                  </div>
                  <h3 className="text-white text-lg font-semibold tracking-tight">
                    {details.title}
                  </h3>
                  <p className="text-zinc-400 text-xs leading-relaxed">
                    {details.description}
                  </p>
                </div>

                {pendingApproval.tool === "request_human_secret" ? (
                  <div className="space-y-4">
                    <div className="space-y-1">
                      <label className="text-[10px] uppercase tracking-wider font-bold text-zinc-500">Secure Vault Input</label>
                      <input
                        type="password"
                        placeholder={`Enter ${pendingApproval.args?.secretId || 'secret'}...`}
                        value={secretInputValue}
                        onChange={(e) => setSecretInputValue(e.target.value)}
                        className="w-full bg-black/40 border border-zinc-800 rounded-xl px-4 py-3 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-emerald-500/50 transition-colors"
                      />
                    </div>
                    <div className="flex gap-3">
                      <button
                        type="button"
                        onClick={() => handleUXApprovalDecision(false)}
                        className="flex-1 py-2.5 rounded-xl border border-zinc-900 hover:border-zinc-800 text-zinc-400 hover:text-white text-xs font-semibold tracking-wide transition-all active:scale-[0.98]"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setPendingApproval(null);
                          setWorkspaceOpen(true);
                          setActiveRightTab('integrations');
                        }}
                        className="flex-1 py-2.5 rounded-xl border border-zinc-800 hover:border-zinc-700 text-zinc-300 hover:text-white text-xs font-semibold tracking-wide transition-all active:scale-[0.98]"
                      >
                        Secrets Vault
                      </button>
                      <button
                        type="button"
                        onClick={handleSecretSubmission}
                        disabled={isSubmittingSecret || !secretInputValue.trim()}
                        className="flex-1 py-2.5 rounded-xl bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-400 border border-emerald-500/20 disabled:opacity-50 text-xs font-semibold tracking-wide transition-all active:scale-[0.98]"
                      >
                        {isSubmittingSecret ? "Vaulting..." : "Vault & Resume"}
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="bg-black/40 border border-zinc-900 rounded-xl p-4 overflow-y-auto max-h-48 font-mono text-[10px] text-zinc-300 space-y-1">
                      <div className="text-zinc-500 font-bold uppercase tracking-wider text-[8px] mb-1">Payload parameters</div>
                      <pre className="whitespace-pre-wrap">{JSON.stringify(pendingApproval.args, null, 2)}</pre>
                    </div>
                    <div className="flex gap-3">
                      <button
                        type="button"
                        onClick={() => handleUXApprovalDecision(false)}
                        className="flex-1 py-2.5 rounded-xl border border-zinc-900 hover:border-zinc-800 text-zinc-400 hover:text-white text-xs font-semibold tracking-wide transition-all active:scale-[0.98]"
                      >
                        Deny Action
                      </button>
                      <button
                        type="button"
                        onClick={() => handleUXApprovalDecision(true)}
                        className="flex-1 py-2.5 rounded-xl bg-zinc-100 hover:bg-white text-black text-xs font-semibold tracking-wide transition-all active:scale-[0.98]"
                      >
                        Approve Action
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          );
        })()}
        {/* Floating Error Toast Notification */}
        {errorToast && (
          <div className="fixed bottom-6 right-6 z-50 flex items-center gap-2 px-4 py-3 text-sm text-red-400 bg-zinc-950 border border-red-500/20 rounded-lg shadow-xl animate-fade-in-up">
            <svg className="w-5 h-5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <span className="font-medium">{errorToast}</span>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
