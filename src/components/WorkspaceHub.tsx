import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { getAccessToken, googleSignIn } from '../lib/firebase';
import { Mail, Calendar, FileText, ChevronRight, ChevronDown, RefreshCw, LogIn, Trash2 } from 'lucide-react';

interface WorkspaceHubProps {
  onInsertContext: (text: string) => void;
}

export default function WorkspaceHub({ onInsertContext }: WorkspaceHubProps) {
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  
  const [emails, setEmails] = useState<any[]>([]);
  const [events, setEvents] = useState<any[]>([]);
  const [files, setFiles] = useState<any[]>([]);
  
  // Expand/collapse states
  const [expandedSection, setExpandedSection] = useState<'calendar' | 'gmail' | 'drive'>('gmail');
  
  // Pagination
  const [emailPageToken, setEmailPageToken] = useState<string | null>(null);

  useEffect(() => {
    getAccessToken().then(t => {
      if (t) {
        setToken(t);
        fetchData(t);
      }
    });
  }, []);

  const handleLogin = async () => {
    try {
      const res = await googleSignIn();
      if (res?.accessToken) {
        setToken(res.accessToken);
        fetchData(res.accessToken);
      }
    } catch (err) {
      console.error(err);
    }
  };

  const fetchData = async (accessToken: string) => {
    setLoading(true);
    try {
      await Promise.all([
        fetchEmails(accessToken),
        fetchEvents(accessToken),
        fetchFiles(accessToken)
      ]);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const fetchEmails = async (accessToken: string, pageToken?: string) => {
    let url = 'https://gmail.googleapis.com/gmail/v1/users/me/messages?q=is:unread&maxResults=5';
    if (pageToken) url += `&pageToken=${pageToken}`;
    
    const mailRes = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    const mailData = await mailRes.json();
    
    if (mailData.messages) {
       const detailedEmails = await Promise.all(mailData.messages.map(async (m: any) => {
         const dRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}`, { headers: { Authorization: `Bearer ${accessToken}` }});
         return await dRes.json();
       }));
       if (pageToken) {
         setEmails(prev => [...prev, ...detailedEmails]);
       } else {
         setEmails(detailedEmails);
       }
       setEmailPageToken(mailData.nextPageToken || null);
    }
  };

  const fetchEvents = async (accessToken: string) => {
    const timeMin = new Date().toISOString();
    const calRes = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${timeMin}&maxResults=5&orderBy=startTime&singleEvents=true`, {
       headers: { Authorization: `Bearer ${accessToken}` }
    });
    const calData = await calRes.json();
    if (calData.items) setEvents(calData.items);
  };

  const fetchFiles = async (accessToken: string) => {
    const driveRes = await fetch('https://www.googleapis.com/drive/v3/files?pageSize=5&orderBy=modifiedTime desc', {
       headers: { Authorization: `Bearer ${accessToken}` }
    });
    const driveData = await driveRes.json();
    if (driveData.files) setFiles(driveData.files);
  };

  const deleteEmail = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!token) return;
    try {
      await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}/trash`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      });
      setEmails(prev => prev.filter(em => em.id !== id));
    } catch (err) {
      console.error('Failed to trash email', err);
    }
  };

  if (!token) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-6 text-center text-[var(--t2)] space-y-6">
        <div className="w-16 h-16 bg-[var(--s2)] rounded-full flex items-center justify-center text-[var(--t4)]">
          <LogIn size={24} />
        </div>
        <div>
          <h3 className="text-[var(--t1)] font-medium text-lg mb-2">Connect Workspace</h3>
          <p className="text-sm max-w-[200px] mb-6">Integrate your Docs, Mail, and Calendar directly into Truth.</p>
          <button 
            onClick={handleLogin}
            className="bg-[var(--t1)] text-[var(--bg)] px-6 py-3 rounded-full text-sm font-medium hover:bg-[var(--t-text-secondary)] transition-colors shadow-lg shadow-[var(--b1)] flex items-center justify-center space-x-2 w-full"
          >
            <span>Connect Google</span>
          </button>
        </div>
      </div>
    );
  }

  const getSubject = (headers: any[]) => headers.find(h => h.name === 'Subject')?.value || 'No Subject';
  const getSender = (headers: any[]) => {
    const from = headers.find(h => h.name === 'From')?.value || 'Unknown';
    // Clean up "Name <email@domain>" format to just show Name if possible
    return from.split(' <')[0].replace(/"/g, '');
  };

  return (
    <div className="h-full flex flex-col overflow-y-auto custom-scrollbar p-6 space-y-6">
      <div className="flex items-center justify-between pb-2 border-b border-[var(--b1)]">
        <h2 className="text-lg font-medium text-[var(--t1)] tracking-tight">Workspace</h2>
        <button onClick={() => fetchData(token)} className="text-[var(--t4)] hover:text-[var(--t1)] transition-colors">
          <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
        </button>
      </div>

      {/* Calendar Section */}
      <section className="space-y-3">
        <button 
          onClick={() => setExpandedSection(expandedSection === 'calendar' ? '' as any : 'calendar')}
          className="w-full flex items-center justify-between text-xs font-semibold text-[var(--t4)] uppercase tracking-wider hover:text-[var(--t1)] transition-colors"
        >
          <div className="flex items-center gap-2"><Calendar size={14} /> Upcoming Meetings</div>
          {expandedSection === 'calendar' ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <AnimatePresence>
          {expandedSection === 'calendar' && (
            <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="space-y-2 overflow-hidden">
              {events.length === 0 && !loading && <div className="text-sm text-[var(--t4)] mt-2">No upcoming events.</div>}
              {events.map(ev => (
                <div 
                  key={ev.id} 
                  onClick={() => onInsertContext(`Event: ${ev.summary}\nTime: ${ev.start?.dateTime || ev.start?.date}\nDescription: ${ev.description || 'None'}`)}
                  className="p-3 rounded-xl bg-[var(--s2)] border border-[var(--b2)] hover:border-[var(--b2)] cursor-pointer group transition-all"
                >
                  <div className="font-medium text-[var(--t1)] text-sm truncate">{ev.summary || 'Untitled Event'}</div>
                  <div className="text-xs text-[var(--t4)] mt-1 flex justify-between items-center">
                    <span>{new Date(ev.start?.dateTime || ev.start?.date).toLocaleString()}</span>
                    <ChevronRight size={14} className="opacity-0 group-hover:opacity-100 transition-opacity" />
                  </div>
                </div>
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </section>

      {/* Gmail Section */}
      <section className="space-y-3">
        <button 
          onClick={() => setExpandedSection(expandedSection === 'gmail' ? '' as any : 'gmail')}
          className="w-full flex items-center justify-between text-xs font-semibold text-[var(--t4)] uppercase tracking-wider hover:text-[var(--t1)] transition-colors"
        >
          <div className="flex items-center gap-2"><Mail size={14} /> Unread Emails {emails.length > 0 && `(${emails.length})`}</div>
          {expandedSection === 'gmail' ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <AnimatePresence>
          {expandedSection === 'gmail' && (
            <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="space-y-2 overflow-hidden">
               {emails.length === 0 && !loading && <div className="text-sm text-[var(--t4)] mt-2">Inbox zero!</div>}
               {emails.map(em => (
                 <div 
                   key={em.id} 
                   onClick={() => onInsertContext(`data:application/vnd.google-apps.mail;base64,${btoa(JSON.stringify({ id: em.id, subject: getSubject(em.payload.headers), from: getSender(em.payload.headers), snippet: em.snippet, date: em.internalDate }))}`)}
                   className="p-3 rounded-xl bg-[var(--s2)] border border-[var(--b2)] hover:border-[var(--b2)] cursor-pointer group transition-all relative overflow-hidden"
                 >
                   <div className="pr-6">
                     <div className="font-medium text-[var(--t1)] text-sm truncate">{getSubject(em.payload.headers)}</div>
                     <div className="text-xs text-[var(--t4)] mt-1 truncate">{getSender(em.payload.headers)}</div>
                     <div className="text-xs text-[var(--t4)] mt-2 line-clamp-2 leading-relaxed">{em.snippet}</div>
                   </div>
                   
                   {/* Delete button that appears on hover */}
                   <button 
                     onClick={(e) => deleteEmail(em.id, e)}
                     className="absolute right-3 top-3 p-1.5 rounded-md bg-red-500/10 text-red-400 opacity-0 group-hover:opacity-100 hover:bg-red-500/20 transition-all"
                     title="Trash email"
                   >
                     <Trash2 size={14} />
                   </button>
                 </div>
               ))}
               
               {emailPageToken && (
                 <button 
                   onClick={() => fetchEmails(token, emailPageToken)}
                   className="w-full py-2 mt-2 text-xs text-[var(--t2)] hover:text-[var(--t1)] bg-[var(--s2)] hover:bg-[var(--s2)] rounded-lg transition-colors border border-transparent hover:border-[var(--b2)]"
                 >
                   {loading ? 'Loading...' : 'Load more emails'}
                 </button>
               )}
            </motion.div>
          )}
        </AnimatePresence>
      </section>

      {/* Drive Section */}
      <section className="space-y-3">
        <button 
          onClick={() => setExpandedSection(expandedSection === 'drive' ? '' as any : 'drive')}
          className="w-full flex items-center justify-between text-xs font-semibold text-[var(--t4)] uppercase tracking-wider hover:text-[var(--t1)] transition-colors"
        >
          <div className="flex items-center gap-2"><FileText size={14} /> Recent Files</div>
          {expandedSection === 'drive' ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <AnimatePresence>
          {expandedSection === 'drive' && (
            <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="space-y-2 overflow-hidden">
               {files.length === 0 && !loading && <div className="text-sm text-[var(--t4)] mt-2">No recent files.</div>}
               {files.map(f => (
                 <div 
                   key={f.id} 
                   onClick={() => onInsertContext(`data:${f.mimeType};base64,${btoa(JSON.stringify({ id: f.id, name: f.name, link: f.webViewLink || `https://docs.google.com/document/d/${f.id}/preview` }))}`)}
                   className="p-3 rounded-xl bg-[var(--s2)] border border-[var(--b2)] hover:border-[var(--b2)] cursor-pointer group transition-all"
                 >
                   <div className="font-medium text-[var(--t1)] text-sm truncate">{f.name}</div>
                   <div className="text-xs text-[var(--t4)] mt-1 flex justify-between items-center">
                     <span className="truncate">{f.mimeType.split('.').pop()}</span>
                     <ChevronRight size={14} className="opacity-0 group-hover:opacity-100 transition-opacity" />
                   </div>
                 </div>
               ))}
            </motion.div>
          )}
        </AnimatePresence>
      </section>
    </div>
  );
}
