import React, { useState, useRef, useEffect } from 'react';
import { useFileAttachment } from './useFileAttachment';
import { FileChip } from './FileChip';
import { FileAttachmentError } from './types';

export const EnterpriseChatInput: React.FC = () => {
  const [text, setText] = useState('');
  const [errorToast, setErrorToast] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Initialize draft from localStorage on mount
  useEffect(() => {
    const savedDraft = localStorage.getItem('chat_draft');
    if (savedDraft) {
      setText(savedDraft);
    }
  }, []);

  // Save draft to localStorage on change
  useEffect(() => {
    if (text) {
      localStorage.setItem('chat_draft', text);
    } else {
      localStorage.removeItem('chat_draft');
    }
  }, [text]);

  // Initialize custom hook with production configurations
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
    maxFiles: 5,                  // Max 5 attachments at a time
    acceptedTypes: ['image/*', 'application/pdf', '.csv', '.xlsx', '.js', '.ts', '.json'],
    onError: (err: FileAttachmentError) => {
      setErrorToast(err.message);
    },
  });

  // Automatically clear notification toasts
  useEffect(() => {
    if (errorToast) {
      const timer = setTimeout(() => setErrorToast(null), 4000);
      return () => clearTimeout(timer);
    }
  }, [errorToast]);

  // Adjust textarea height dynamically based on contents
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 300)}px`;
    }
  }, [text]);

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim() && attachments.length === 0) return;
    setIsSending(true);

    // Output payload for demo context (containing Base64 strings)
    console.log('Sending message:', {
      text,
      attachments: attachments.map(att => ({
        filename: att.name,
        type: att.type,
        base64Payload: att.dataUrl.substring(0, 100) + '...[TRUNCATED]' // Showing hidden base64 string
      }))
    });

    // Simulate network delay for the spinner
    await new Promise(resolve => setTimeout(resolve, 800));

    // Reset Form States
    setText('');
    localStorage.removeItem('chat_draft');
    clearAttachments();
    setIsSending(false);

    // Refocus the textarea after clearing
    setTimeout(() => {
      textareaRef.current?.focus();
    }, 10);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend(e);
    }
  };

  const triggerFileSelect = () => {
    fileInputRef.current?.click();
  };

  return (
    <div className="w-full max-w-3xl mx-auto px-4 py-8">
      <form 
        onSubmit={handleSend}
        className={`relative flex flex-col w-full rounded-[1.5rem] border border-white/10 transition-all duration-300 shadow-md backdrop-blur-xl ${
          isDragging 
            ? 'border-indigo-500 ring-2 ring-indigo-500/10 bg-indigo-50/50 dark:bg-[#252525]/90' 
            : 'bg-[#212121]/90 focus-within:bg-[#252525] focus-within:border-white/25 focus-within:shadow-[0_8px_32px_rgba(0,0,0,0.5)]'
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
          <div className="absolute inset-0 z-50 flex flex-col items-center justify-center rounded-xl bg-indigo-500/5 backdrop-blur-[1px] pointer-events-none border-2 border-dashed border-indigo-400">
            <svg className="w-10 h-10 text-indigo-500 animate-bounce mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 16.5V9.75m0 0l3 3m-3-3l-3 3M6.75 19.5a4.5 4.5 0 01-1.41-8.775 5.25 5.25 0 0110.233-2.33 3 3 0 013.758 3.848A3.752 3.752 0 0118 19.5H6.75z" />
            </svg>
            <p className="text-sm font-semibold text-indigo-600 dark:text-indigo-400">Drop files here to instantly attach</p>
          </div>
        )}

        {/* Attachment Preview Bar */}
        {attachments.length > 0 && (
          <div 
            className="flex flex-wrap gap-2 p-4 pb-0"
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

        {/* Textarea Input Node */}
        <div className="flex items-start gap-2 px-4 py-4 min-h-[50px]">
          <textarea
            ref={textareaRef}
            rows={1}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Write a message, drop files, or paste screenshot here..."
            className="flex-1 w-full text-[15px] font-outfit resize-none bg-transparent border-0 outline-none p-1 focus:ring-0 text-slate-100 placeholder-zinc-600 leading-relaxed font-normal min-h-[28px] max-h-[300px]"
            {...pasteProps}
          />
        </div>

        {/* Toolbar Footer Actions */}
        <div className="flex items-center justify-between px-4 pb-3 pt-1">
          {/* Left Toolbar actions */}
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={triggerFileSelect}
              className="p-2 text-zinc-400 hover:text-white hover:bg-white/10 rounded-full transition-colors duration-150 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
              aria-label="Attach local files"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M18.364 5.636l-3.536 3.536m0 0A3 3 0 1011.243 13.43l3.536-3.536m0 0L14.73 9.35M18.364 5.636a9 9 0 01-12.728 0m12.728 0L17.3 6.7m-11.664-.064a9 9 0 000 12.728m0 0l3.536-3.536m0 0l-1.129-1.13" />
              </svg>
            </button>
            <span className="text-[11px] text-zinc-500 font-medium hidden sm:inline-block">
              {attachments.length} of 5 files loaded
            </span>
          </div>

          {/* Right Submit Trigger */}
          <button
            type="submit"
            disabled={!text.trim() && attachments.length === 0 || isSending}
            className={`flex items-center justify-center w-8 h-8 rounded-full transition-all duration-150 focus:outline-none focus:ring-2 focus:ring-white/20 ${
              text.trim() || attachments.length > 0
                ? 'bg-white text-black hover:bg-zinc-200 active:scale-[0.95]'
                : 'bg-zinc-800 text-zinc-600 cursor-not-allowed'
            }`}
          >
            {isSending ? (
              <div className="w-4 h-4 border-2 border-black/20 border-t-black rounded-full animate-spin" />
            ) : (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M14 5l7 7m0 0l-7 7m7-7H3" />
              </svg>
            )}
          </button>
        </div>
      </form>

      {/* Floating Error Toast Notification */}
      {errorToast && (
        <div className="fixed bottom-6 right-6 z-50 flex items-center gap-2 px-4 py-3 text-sm text-red-800 bg-red-50 border border-red-200 rounded-lg shadow-xl dark:bg-red-950/60 dark:text-red-200 dark:border-red-900/80 animate-fade-in-up">
          <svg className="w-5 h-5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          <span className="font-medium">{errorToast}</span>
        </div>
      )}
    </div>
  );
};
