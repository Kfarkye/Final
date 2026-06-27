/**
 * TRUTH PLATFORM — ENTERPRISE ACCESSIBLE DROPDOWN MENU
 * 
 * [Accessibility & Design Specifications]:
 * - Keyboard Support: Full WAI-ARIA compliance via Radix UI Dropdown Menu primitive.
 * - Focus Management: Automatic focus trapping, escape key closing, and arrow key navigation.
 * - Glassmorphism: Frosted bg-slate-900/80 backdrop-blur-md with 100% opacity content.
 * - Visual Depth: Subtle border-slate-800/80, 2px ring indicators, and a layered shadow-2xl.
 * - Micro-interactions: Custom scale, slide, and fade-in states driven by Radix attributes.
 */

import React, { useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { 
  ChevronRight, 
  Settings, 
  Terminal, 
  GitBranch, 
  Check, 
  Layers, 
  LogOut, 
  Cpu, 
  User, 
  BookOpen, 
  Zap 
} from "lucide-react";

// ============================================================================
// Custom Micro-Animation Classes (Tailwind & Radix State Selectors)
// ============================================================================
const contentAnimationClasses = `
  will-change-[opacity,transform]
  data-[state=open]:animate-[slideDownAndFade_150ms_cubic-bezier(0.16,1,0.3,1)]
  data-[state=closed]:animate-[fadeOut_100ms_ease-in]
`;

export const TruthDropdownMenuShowcase: React.FC = () => {
  // Demo states for checkbox & radio items inside our dropdown
  const [isSandboxActive, setIsSandboxActive] = useState(true);
  const [isGcpProxyLive, setIsGcpConnected] = useState(true);
  const [activeWorkspace, setActiveWorkspace] = useState("reverie-core");

  return (
    <div className="min-h-screen bg-[#0B0F19] text-slate-100 flex flex-col items-center justify-center p-6 relative overflow-hidden">
      
      {/* Decorative backdrop gradients matching Truth Platform theme */}
      <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-cyan-500/10 rounded-full blur-[120px] pointer-events-none"></div>
      <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-purple-500/10 rounded-full blur-[120px] pointer-events-none"></div>

      <div className="z-10 text-center space-y-4 mb-8">
        <span className="text-[10px] bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 px-2.5 py-1 rounded-full font-mono tracking-wider uppercase">
          Accessible Component Spec
        </span>
        <h1 className="text-3xl font-extrabold tracking-tight text-[var(--t1)] font-sans">
          Truth Workspace Controller
        </h1>
        <p className="text-sm text-slate-400 max-w-md mx-auto">
          Press <kbd className="bg-slate-900 border border-slate-800 px-1.5 py-0.5 rounded font-mono text-xs text-slate-300">Tab</kbd> to focus, and <kbd className="bg-slate-900 border border-slate-800 px-1.5 py-0.5 rounded font-mono text-xs text-slate-300">Enter</kbd> or <kbd className="bg-slate-900 border border-slate-800 px-1.5 py-0.5 rounded font-mono text-xs text-slate-300">Space</kbd> to open. Navigate with arrow keys.
        </p>
      </div>

      {/* RADIX CORE SYSTEM INTEGRATION */}
      <DropdownMenu.Root>
        
        {/* Dropdown Trigger Button */}
        <DropdownMenu.Trigger asChild>
          <button 
            className="
              group flex items-center space-x-2.5 px-5 py-3 
              bg-gradient-to-r from-slate-900 to-slate-900/90 
              border border-slate-800/80 hover:border-slate-700/90 
              text-sm font-semibold text-[var(--t1)] rounded-xl shadow-lg 
              hover:shadow-cyan-500/5 focus:outline-none focus:ring-2 
              focus:ring-cyan-500/50 focus:ring-offset-2 focus:ring-offset-[#0B0F19] 
              transition-all duration-200 cursor-pointer
            "
            aria-label="Workspace Configurations Menu"
          >
            <Layers className="w-4 h-4 text-cyan-400 group-hover:scale-110 transition-transform duration-200" />
            <span>Workspace: <strong className="text-cyan-400 font-mono">{activeWorkspace}</strong></span>
            <ChevronRight className="w-4 h-4 text-slate-500 group-data-[state=open]:rotate-90 transition-transform duration-200" />
          </button>
        </DropdownMenu.Trigger>

        {/* Portal forces absolute rendering in layout overlays */}
        <DropdownMenu.Portal>
          
          {/* Menu Content Container */}
          <DropdownMenu.Content 
            className={`
              min-w-[280px] bg-slate-950/80 backdrop-blur-md 
              border border-gray-700/60 rounded-xl p-2 
              shadow-[0_25px_50px_-12px_rgba(0,0,0,0.5)] z-50
              ${contentAnimationClasses}
            `}
            sideOffset={8}
            align="center"
          >
            
            {/* Context/Profile Header section */}
            <div className="px-3 py-2.5 mb-1.5 border-b border-slate-800/60">
              <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">Context Session</span>
              <div className="flex items-center space-x-2.5 mt-1">
                <div className="w-6 h-6 rounded-md bg-gradient-to-br from-cyan-500 to-purple-500 flex items-center justify-center font-bold text-[10px] text-[var(--t1)]">
                  TR
                </div>
                <div>
                  <span className="text-xs font-semibold text-slate-200 block">usr_94821a8fce71</span>
                  <span className="text-[9px] text-slate-500 block font-mono">Role: billing_manager</span>
                </div>
              </div>
            </div>

            {/* Standard Dropdown Items */}
            <DropdownMenu.Item className="dropdown-item group">
              <div className="flex items-center space-x-2.5">
                <User className="w-4 h-4 text-slate-500 group-hover:text-cyan-400 transition" />
                <span>Account Profile</span>
              </div>
              <span className="shortcut-tag">⇧⌘A</span>
            </DropdownMenu.Item>

            <DropdownMenu.Item className="dropdown-item group">
              <div className="flex items-center space-x-2.5">
                <Settings className="w-4 h-4 text-slate-500 group-hover:text-cyan-400 transition" />
                <span>Platform Settings</span>
              </div>
              <span className="shortcut-tag">⌘,</span>
            </DropdownMenu.Item>

            {/* NESTED SUBMENU (Radix primitives automate delay triggers & position calculations) */}
            <DropdownMenu.Sub>
              <DropdownMenu.SubTrigger className="dropdown-item group justify-between">
                <div className="flex items-center space-x-2.5">
                  <GitBranch className="w-4 h-4 text-slate-500 group-hover:text-cyan-400 transition" />
                  <span>Switch Workspace</span>
                </div>
                <ChevronRight className="w-3.5 h-3.5 text-slate-500 group-hover:text-[var(--t1)] transition" />
              </DropdownMenu.SubTrigger>
              
              <DropdownMenu.Portal>
                <DropdownMenu.SubContent 
                  className={`
                    min-w-[200px] bg-slate-950/90 backdrop-blur-md 
                    border border-gray-700/60 rounded-xl p-2 
                    shadow-2xl z-50 ${contentAnimationClasses}
                  `}
                  sideOffset={4}
                  alignOffset={-6}
                >
                  <DropdownMenu.RadioGroup value={activeWorkspace} onValueChange={setActiveWorkspace}>
                    <DropdownMenu.RadioItem value="reverie-core" className="dropdown-item pl-8 relative">
                      <DropdownMenu.ItemIndicator className="absolute left-2.5 flex items-center justify-center">
                        <Check className="w-3.5 h-3.5 text-cyan-400" />
                      </DropdownMenu.ItemIndicator>
                      <span>reverie-core</span>
                    </DropdownMenu.RadioItem>

                    <DropdownMenu.RadioItem value="aura-governance" className="dropdown-item pl-8 relative">
                      <DropdownMenu.ItemIndicator className="absolute left-2.5 flex items-center justify-center">
                        <Check className="w-3.5 h-3.5 text-cyan-400" />
                      </DropdownMenu.ItemIndicator>
                      <span>aura-governance</span>
                    </DropdownMenu.RadioItem>

                    <DropdownMenu.RadioItem value="sandbox-playground" className="dropdown-item pl-8 relative">
                      <DropdownMenu.ItemIndicator className="absolute left-2.5 flex items-center justify-center">
                        <Check className="w-3.5 h-3.5 text-cyan-400" />
                      </DropdownMenu.ItemIndicator>
                      <span>sandbox-playground</span>
                    </DropdownMenu.RadioItem>
                  </DropdownMenu.RadioGroup>
                </DropdownMenu.SubContent>
              </DropdownMenu.Portal>
            </DropdownMenu.Sub>

            {/* Separator block */}
            <DropdownMenu.Separator className="h-[1px] bg-slate-800/80 my-1.5" />

            {/* Interactive Checkbox Items */}
            <DropdownMenu.CheckboxItem 
              checked={isSandboxActive} 
              onCheckedChange={setIsSandboxActive}
              className="dropdown-item pl-8 relative group"
            >
              <DropdownMenu.ItemIndicator className="absolute left-2.5 flex items-center justify-center">
                <Check className="w-3.5 h-3.5 text-cyan-400" />
              </DropdownMenu.ItemIndicator>
              <div className="flex items-center space-x-2.5">
                <Terminal className="w-4 h-4 text-slate-500 group-hover:text-cyan-400 transition" />
                <span>Sandbox Active</span>
              </div>
              <span className="shortcut-tag">⌥S</span>
            </DropdownMenu.CheckboxItem>

            <DropdownMenu.CheckboxItem 
              checked={isGcpProxyLive} 
              onCheckedChange={setIsGcpConnected}
              className="dropdown-item pl-8 relative group"
            >
              <DropdownMenu.ItemIndicator className="absolute left-2.5 flex items-center justify-center">
                <Check className="w-3.5 h-3.5 text-cyan-400" />
              </DropdownMenu.ItemIndicator>
              <div className="flex items-center space-x-2.5">
                <Cpu className="w-4 h-4 text-slate-500 group-hover:text-cyan-400 transition" />
                <span>GCP Multi-Sync Link</span>
              </div>
              <span className="shortcut-tag">⌥G</span>
            </DropdownMenu.CheckboxItem>

            {/* Separator block */}
            <DropdownMenu.Separator className="h-[1px] bg-slate-800/80 my-1.5" />

            {/* Destructive Log out Action */}
            <DropdownMenu.Item className="dropdown-item text-rose-400 focus:bg-rose-500/10 focus:text-rose-300 group">
              <div className="flex items-center space-x-2.5">
                <LogOut className="w-4 h-4 text-rose-500/60 group-hover:text-rose-400 transition" />
                <span>Logout Session</span>
              </div>
              <span className="shortcut-tag text-rose-500/50">⇧⌘Q</span>
            </DropdownMenu.Item>

          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      {/* Tailwind animation keyframe injection */}
      <style>{`
        @keyframes slideDownAndFade {
          from { opacity: 0; transform: translateY(-4px) scale(0.98); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
        @keyframes fadeOut {
          from { opacity: 1; transform: scale(1); }
          to { opacity: 0; transform: scale(0.98); }
        }
      `}</style>

      {/* CSS Utility Mappings inside JSX for showcase isolation */}
      <style>{`
        .dropdown-item {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 7px 12px;
          font-size: 13px;
          font-weight: 500;
          color: #94a3b8; /* text-slate-400 */
          border-radius: 8px;
          cursor: pointer;
          user-select: none;
          outline: none;
          transition: all 120ms ease;
        }
        .dropdown-item:focus {
          background-color: rgba(6, 182, 212, 0.08); /* bg-cyan-500/10 */
          color: #ffffff; /* text-[var(--t1)] */
        }
        .shortcut-tag {
          font-family: monospace;
          font-size: 10px;
          color: #475569; /* text-slate-500 */
          letter-spacing: 0.05em;
        }
        .dropdown-item:focus .shortcut-tag {
          color: rgba(6, 182, 212, 0.6); /* cyan-400 text-opacity */
        }
      `}</style>

    </div>
  );
};
