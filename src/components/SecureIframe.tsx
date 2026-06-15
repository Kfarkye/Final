import React, { IframeHTMLAttributes } from 'react';

interface SecureIframeProps extends IframeHTMLAttributes<HTMLIFrameElement> {
  title: string;
  sandboxOptions?: string[]; // e.g., ['allow-scripts', 'allow-same-origin']
}

export function SecureIframe({ 
  title, 
  sandboxOptions = ['allow-scripts', 'allow-same-origin', 'allow-forms'], 
  className = '', 
  ...props 
}: SecureIframeProps) {
  const sandboxConfig = sandboxOptions.join(' ');
  
  return (
    <div className={`relative w-full overflow-hidden rounded-xl border border-white/20 shadow-xl bg-white ${className}`}>
      <div className="bg-zinc-900 px-4 py-2.5 border-b border-white/10 flex items-center justify-between text-xs font-mono text-zinc-400">
        <div className="flex gap-2 items-center">
          <div className="flex gap-1.5 mr-2">
            <div className="w-2.5 h-2.5 rounded-full bg-red-500/50"></div>
            <div className="w-2.5 h-2.5 rounded-full bg-yellow-500/50"></div>
            <div className="w-2.5 h-2.5 rounded-full bg-green-500/50"></div>
          </div>
          <span className="uppercase tracking-widest">{title}</span>
        </div>
        <div className="flex gap-2">
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-sans tracking-wide">
            Protected Sandbox
          </span>
        </div>
      </div>
      <iframe 
        title={title}
        sandbox={sandboxConfig}
        loading="lazy"
        referrerPolicy="no-referrer"
        // Start locked down feature policy by default for enterprise security
        allow="camera 'none'; microphone 'none'; geolocation 'none'; payment 'none'; usb 'none'"
        className="w-full min-h-[500px] h-full border-none block"
        {...props} 
      />
    </div>
  );
}
