import React, { useState, useEffect } from 'react';
import { motion } from 'motion/react';
import { Download, FileText, Mail, HardDrive, X, MessageSquare, RefreshCw, ChevronDown } from 'lucide-react';
import { generateMarkdown, generatePDFDoc, saveToDrive, sendEmailAttachment, getChatSpaces, sendChatMessage } from '../lib/exportUtils';
import { getAccessToken, db } from '../lib/firebase';
import { logAuditAction } from '../lib/audit';
import { collection, addDoc, serverTimestamp } from 'firebase/firestore';

interface ExportDialogProps {
  onClose: () => void;
  turns: any[];
  topic: string;
  currentUser: any;
}

export default function ExportDialog({ onClose, turns, topic, currentUser }: ExportDialogProps) {
  const [format, setFormat] = useState<'pdf' | 'md'>('pdf');
  const [email, setEmail] = useState(currentUser?.email || '');
  const [isExporting, setIsExporting] = useState(false);
  const [message, setMessage] = useState<{type: 'success'|'error', text: string} | null>(null);
  const [spaces, setSpaces] = useState<any[]>([]);
  const [selectedSpace, setSelectedSpace] = useState<string>('');
  const [loadingSpaces, setLoadingSpaces] = useState(false);

  const loadChatSpaces = async () => {
     setLoadingSpaces(true);
     setMessage(null);
     try {
       const token = await getAccessToken();
       if (!token) throw new Error("Google Workspace not connected.");
       const chatSpaces = await getChatSpaces(token);
       setSpaces(chatSpaces);
       if (chatSpaces.length > 0) {
         setSelectedSpace(chatSpaces[0].name);
       } else {
         setMessage({ type: 'success', text: 'No Chat spaces found.' });
       }
     } catch (err: any) {
       console.error(err);
       setMessage({ type: 'error', text: err.message || 'Failed to load Chat spaces.'});
     } finally {
       setLoadingSpaces(false);
     }
  };

  const handleExport = async (action: 'download' | 'drive' | 'email' | 'chat') => {
    setIsExporting(true);
    setMessage(null);
    try {
      const fileName = `Export_${topic.replace(/\s+/g, '_')}_${Date.now()}.${format}`;
      const mimeType = format === 'pdf' ? 'application/pdf' : 'text/markdown';
      
      logAuditAction(currentUser, 'EXPORT', { format, target: action, topic });

      let fileContentBase64 = '';
      let fileContentPlain = '';

      if (format === 'pdf') {
         const doc = generatePDFDoc(turns, topic, currentUser);
         const dataUri = doc.output('datauristring');
         fileContentBase64 = dataUri.split(',')[1];
      } else {
         fileContentPlain = generateMarkdown(turns, topic, currentUser);
      }

      const token = await getAccessToken();

      if (action === 'download') {
         if (format === 'pdf') {
            const doc = generatePDFDoc(turns, topic, currentUser);
            doc.save(fileName);
         } else {
            const blob = new Blob([fileContentPlain], { type: 'text/markdown' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = fileName;
            a.click();
            URL.revokeObjectURL(url);
         }
         setMessage({ type: 'success', text: 'Downloaded successfully.' });
      } else if (action === 'drive') {
         if (!token) throw new Error("Google Workspace not connected.");
         await saveToDrive(
            token, 
            format === 'pdf' ? fileContentBase64 : fileContentPlain, 
            fileName, 
            mimeType, 
            format === 'pdf'
         );
         setMessage({ type: 'success', text: 'Saved to Google Drive.' });
      } else if (action === 'email') {
         if (!token) throw new Error("Google Workspace not connected.");
         if (!email) throw new Error("Email address required.");
         await sendEmailAttachment(
            token,
            email,
            `Conversation Export: ${topic}`,
            `Please find the exported conversation attached.\n\nTopic: ${topic}\nDate: ${new Date().toLocaleString()}`,
            format === 'pdf' ? fileContentBase64 : fileContentPlain,
            fileName,
            mimeType,
            format === 'pdf'
         );
         
         // Log the manual email send event to Firebase Firestore
         try {
           const emailsCol = collection(db, 'users', currentUser.uid, 'emails');
           await addDoc(emailsCol, {
             type: 'manual_export',
             recipient: email,
             subject: `Conversation Export: ${topic}`,
             format,
             timestamp: serverTimestamp()
           });
         } catch (e) {
           console.error("Failed to log manual email to Firestore", e);
         }

         setMessage({ type: 'success', text: `Emailed to ${email}` });
      } else if (action === 'chat') {
         if (!token) throw new Error("Google Workspace not connected.");
         if (!selectedSpace) throw new Error("Please select a space first.");
         const plainText = generateMarkdown(turns, topic, currentUser);
         await sendChatMessage(token, selectedSpace, plainText);
         setMessage({ type: 'success', text: 'Sent to Google Chat.' });
      }

    } catch (err: any) {
      console.error(err);
      setMessage({ type: 'error', text: err.message || 'Export failed.' });
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[var(--bg)]/60 backdrop-blur-sm">
      <motion.div 
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        className="bg-[var(--s2)] border border-[var(--b1)] rounded-2xl w-full max-w-md overflow-hidden shadow-2xl"
      >
        <div className="p-6 border-b border-[var(--b1)] flex justify-between items-center bg-[var(--s2)]">
          <h2 className="text-lg font-medium text-[var(--t1)] flex items-center gap-2">
            <Download size={18} /> Export Conversation
          </h2>
          <button onClick={onClose} className="text-[var(--t4)] hover:text-[var(--t1)] transition-colors">
            <X size={18} />
          </button>
        </div>
        
        <div className="p-6 space-y-6">
          {message && (
             <div className={`p-3 rounded-lg text-sm ${message.type === 'success' ? 'bg-green-500/10 text-green-400 border border-green-500/20' : 'bg-red-500/10 text-red-400 border border-red-500/20'}`}>
               {message.text}
             </div>
          )}

          <div className="space-y-3">
            <label className="text-xs uppercase tracking-wider font-semibold text-[var(--t4)]">Format</label>
            <div className="flex gap-3">
              <button 
                onClick={() => setFormat('pdf')} 
                className={`flex-1 py-3 px-4 rounded-xl border flex items-center justify-center gap-2 transition-colors ${format === 'pdf' ? 'bg-[var(--t1)] text-[var(--bg)] border-[var(--t1)]' : 'bg-[var(--s2)] border-[var(--b1)] text-[var(--t2)] hover:text-[var(--t1)] hover:border-[var(--b2)]'}`}
              >
                <FileText size={18} /> PDF Document
              </button>
              <button 
                onClick={() => setFormat('md')} 
                className={`flex-1 py-3 px-4 rounded-xl border flex items-center justify-center gap-2 transition-colors ${format === 'md' ? 'bg-[var(--t1)] text-[var(--bg)] border-[var(--t1)]' : 'bg-[var(--s2)] border-[var(--b1)] text-[var(--t2)] hover:text-[var(--t1)] hover:border-[var(--b2)]'}`}
              >
                <FileText size={18} /> Markdown
              </button>
            </div>
          </div>

          <div className="space-y-3">
             <label className="text-xs uppercase tracking-wider font-semibold text-[var(--t4)]">Local Download</label>
             <button 
               onClick={() => handleExport('download')}
               disabled={isExporting || turns.length === 0}
               className="w-full py-3 px-4 rounded-xl border border-[var(--b1)] bg-[var(--s2)] hover:bg-[var(--s1)] text-[var(--t1)] flex items-center justify-center gap-2 transition-colors disabled:opacity-50"
             >
               <Download size={18} /> Save to Device
             </button>
          </div>

          <div className="space-y-3 pt-4 border-t border-[var(--b1)]">
             <label className="text-xs uppercase tracking-wider font-semibold text-[var(--t4)]">Workspace Integrations</label>
             <button 
               onClick={() => handleExport('drive')}
               disabled={isExporting || turns.length === 0}
               className="w-full py-3 px-4 rounded-xl border border-blue-500/30 bg-blue-500/10 hover:bg-blue-500/20 text-blue-400 flex items-center justify-center gap-2 transition-colors disabled:opacity-50"
             >
               <HardDrive size={16} /> Save to Google Drive
             </button>
             
             <div className="flex gap-2">
               <input 
                 type="email" 
                 placeholder="Email address" 
                 value={email}
                 onChange={e => setEmail(e.target.value)}
                 className="flex-1 bg-[var(--s2)] border border-[var(--b1)] rounded-xl px-4 text-sm text-[var(--t1)] focus:border-[var(--b2)] focus:outline-none"
               />
               <button 
                 onClick={() => handleExport('email')}
                 disabled={isExporting || turns.length === 0 || !email}
                 className="py-3 px-4 rounded-xl border border-indigo-500/30 bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-400 flex items-center justify-center gap-2 transition-colors disabled:opacity-50 whitespace-nowrap"
               >
                 <Mail size={16} /> Send Email
               </button>
             </div>
             <p className="text-[10px] text-[var(--t4)] mt-2 text-center">Requires Workspace connection with proper permissions.</p>
          </div>

          <div className="space-y-3 pt-4 border-t border-[var(--b1)]">
             <div className="flex items-center justify-between">
               <label className="text-xs uppercase tracking-wider font-semibold text-[var(--t4)]">Google Chat</label>
               {spaces.length === 0 && (
                 <button onClick={loadChatSpaces} disabled={loadingSpaces} className="text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1">
                   <RefreshCw size={12} className={loadingSpaces ? "animate-spin" : ""} /> Load Spaces
                 </button>
               )}
             </div>
             
             {spaces.length > 0 && (
               <div className="flex gap-2">
                 <div className="relative flex-1">
                   <select 
                     value={selectedSpace}
                     onChange={e => setSelectedSpace(e.target.value)}
                     className="w-full h-full bg-[var(--s2)] border border-[var(--b1)] rounded-xl px-4 py-3 text-sm text-[var(--t1)] focus:border-[var(--b2)] focus:outline-none appearance-none"
                   >
                     <option value="" disabled>Select a Space</option>
                     {spaces.map(s => (
                       <option key={s.name} value={s.name}>{s.displayName || s.name}</option>
                     ))}
                   </select>
                   <ChevronDown size={16} className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-[var(--t4)]" />
                 </div>
                 <button 
                   onClick={() => handleExport('chat')}
                   disabled={isExporting || turns.length === 0 || !selectedSpace}
                   className="py-3 px-4 rounded-xl border border-teal-500/30 bg-teal-500/10 hover:bg-teal-500/20 text-teal-400 flex items-center justify-center gap-2 transition-colors disabled:opacity-50 whitespace-nowrap"
                 >
                   <MessageSquare size={16} /> Send to Space
                 </button>
               </div>
             )}
          </div>
          
        </div>
      </motion.div>
    </div>
  );
}
