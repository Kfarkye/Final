import { useNavigate } from "react-router-dom";
import { Link } from "react-router-dom";
import { motion } from "motion/react";

export default function LandingPage() {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen flex flex-col font-sans bg-black text-[#EDEDED] selection:bg-zinc-800">
      {/* Header */}
      <header className="py-8 px-8 flex justify-between items-center max-w-[1400px] mx-auto w-full">
        <div className="text-2xl font-serif tracking-tight font-medium flex items-center space-x-3">
           <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-white"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg>
           <span>Truth.</span>
        </div>
        <nav className="hidden md:flex space-x-10 text-sm tracking-wide text-zinc-400 font-medium">
          <a href="#how" className="hover:text-white transition-colors duration-300">Architecture</a>
          <a href="#models" className="hover:text-white transition-colors duration-300">Engines</a>
          <a href="#pricing" className="hover:text-white transition-colors duration-300">Access</a>
        </nav>
      </header>

      {/* Hero */}
      <main className="flex-1 flex flex-col items-center justify-center text-center px-4 py-32">
        <motion.div
           initial={{ opacity: 0, scale: 0.95 }}
           animate={{ opacity: 1, scale: 1 }}
           transition={{ duration: 1, ease: [0.16, 1, 0.3, 1] }}
           className="inline-flex items-center space-x-2 border border-white/10 rounded-full px-4 py-1.5 mb-8 bg-white/5 backdrop-blur-sm"
        >
           <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
           <span className="text-xs font-semibold tracking-widest uppercase text-zinc-300">System Online</span>
        </motion.div>
        
        <motion.h1 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 1, ease: [0.16, 1, 0.3, 1], delay: 0.1 }}
          className="text-6xl md:text-8xl font-serif tracking-tighter font-medium max-w-5xl leading-[1.1] mb-8 text-white"
        >
          Compare four minds.<br /><span className="text-zinc-500">Find the truth.</span>
        </motion.h1>
        
        <motion.p 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 1, ease: [0.16, 1, 0.3, 1], delay: 0.2 }}
          className="text-xl md:text-2xl text-zinc-400 max-w-2xl mb-16 tracking-tight font-light"
        >
          An enterprise-grade cross-examination suite. Query Gemini, ChatGPT, Claude, and Grok concurrently.
        </motion.p>
        
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 1, ease: [0.16, 1, 0.3, 1], delay: 0.3 }}
          className="flex flex-col sm:flex-row gap-6 items-center mb-32"
        >
          <button 
            onClick={() => navigate('/onboarding')}
            className="bg-white text-black px-10 py-5 rounded-full text-lg font-medium hover:scale-105 transition-all duration-300 min-w-[220px] shadow-[0_0_40px_rgba(255,255,255,0.1)]"
          >
            Enter the Suite
          </button>
          <a href="#how" className="text-zinc-400 hover:text-white font-medium px-6 py-4 tracking-wide transition-colors">
            System Architecture
          </a>
        </motion.div>

        {/* Three Columns */}
        <motion.section 
          initial={{ opacity: 0, y: 40 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 1, ease: [0.16, 1, 0.3, 1] }}
          id="how" 
          className="grid grid-cols-1 md:grid-cols-3 gap-16 max-w-[1400px] mx-auto text-left px-8 py-32 border-t border-white/5"
        >
          <div className="group">
            <h3 className="text-2xl font-serif font-medium mb-6 text-white group-hover:text-zinc-300 transition-colors">Parallel Execution.</h3>
            <p className="text-zinc-400 leading-relaxed font-light text-lg">
              Dispatch a single query to the top foundational models simultaneously. Eliminate latency, tab-switching, and context fragmentation.
            </p>
          </div>
          <div className="group">
            <h3 className="text-2xl font-serif font-medium mb-6 text-white group-hover:text-zinc-300 transition-colors">Consensus Triangulation.</h3>
            <p className="text-zinc-400 leading-relaxed font-light text-lg">
              Isolate hallucinations and bypass structural biases. Analyze four distinct cognitive architectures to synthesize an objective truth.
            </p>
          </div>
          <div className="group">
            <h3 className="text-2xl font-serif font-medium mb-6 text-white group-hover:text-zinc-300 transition-colors">Zero Compromise.</h3>
            <p className="text-zinc-400 leading-relaxed font-light text-lg">
              Unmetered, unthrottled access designed for the 1%. Bring your own API keys or operate securely behind our sovereign enterprise proxy.
            </p>
          </div>
        </motion.section>

        {/* Models Section */}
        <motion.section 
          initial={{ opacity: 0, y: 40 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 1, ease: [0.16, 1, 0.3, 1] }}
          id="models" 
          className="max-w-[1400px] mx-auto px-8 py-32 rounded-[2.5rem] mb-32 text-left w-full border border-white/10 bg-zinc-950 shadow-2xl overflow-hidden relative"
        >
          <div className="absolute top-0 left-1/2 -translate-x-1/2 w-full h-[1px] bg-gradient-to-r from-transparent via-white/20 to-transparent"></div>
          
          <div className="max-w-4xl mx-auto">
            <h2 className="text-4xl md:text-5xl font-serif font-medium mb-8 text-white tracking-tight">The intellects at your disposal.</h2>
            <p className="text-xl text-zinc-400 leading-relaxed mb-16 font-light max-w-2xl">
              We integrate exclusively with the bleeding edge of foundation models.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
               <div className="bg-black p-8 rounded-3xl border border-white/5 hover:border-white/20 transition-all duration-300 flex flex-col">
                  <span className="text-xs uppercase tracking-[0.2em] font-bold text-zinc-500 mb-4">Google</span>
                  <span className="text-2xl font-serif text-white">Gemini 1.5 Pro</span>
               </div>
               <div className="bg-black p-8 rounded-3xl border border-white/5 hover:border-white/20 transition-all duration-300 flex flex-col">
                  <span className="text-xs uppercase tracking-[0.2em] font-bold text-zinc-500 mb-4">OpenAI</span>
                  <span className="text-2xl font-serif text-white">GPT-4o</span>
               </div>
               <div className="bg-black p-8 rounded-3xl border border-white/5 hover:border-white/20 transition-all duration-300 flex flex-col">
                  <span className="text-xs uppercase tracking-[0.2em] font-bold text-zinc-500 mb-4">Anthropic</span>
                  <span className="text-2xl font-serif text-white">Claude 3.7 Sonnet</span>
               </div>
               <div className="bg-black p-8 rounded-3xl border border-white/5 hover:border-white/20 transition-all duration-300 flex flex-col">
                  <span className="text-xs uppercase tracking-[0.2em] font-bold text-zinc-500 mb-4">xAI</span>
                  <span className="text-2xl font-serif text-white">Grok-2</span>
               </div>
            </div>
          </div>
        </motion.section>

        {/* Pricing */}
        <motion.section 
          initial={{ opacity: 0, y: 40 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 1, ease: [0.16, 1, 0.3, 1] }}
          id="pricing" 
          className="max-w-[1400px] mx-auto px-8 py-32 w-full mb-20"
        >
          <div className="text-center mb-24">
            <h2 className="text-5xl md:text-6xl font-serif font-medium text-white tracking-tight mb-6">Uncompromising Access.</h2>
            <p className="text-xl text-zinc-400 font-light max-w-2xl mx-auto">Designed for those who cannot afford to be wrong.</p>
          </div>
          
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8 text-left max-w-6xl mx-auto">
             <div className="border border-white/10 p-10 rounded-[2.5rem] bg-zinc-950/50 hover:bg-zinc-950 transition-colors">
                <h3 className="text-2xl font-serif font-medium mb-2 text-white">BYOK Tier</h3>
                <div className="text-5xl font-serif mb-8 text-white">$0<span className="text-xl text-zinc-500 font-sans tracking-normal">/mo</span></div>
                <p className="text-zinc-400 font-light mb-8 h-12">Connect your own API endpoints. You handle the billing.</p>
                <div className="space-y-4 mb-12">
                  <div className="flex items-center text-zinc-400 text-sm"><span className="mr-3 text-white">✓</span> Local execution client</div>
                  <div className="flex items-center text-zinc-400 text-sm"><span className="mr-3 text-white">✓</span> Basic rate limiting</div>
                  <div className="flex items-center text-zinc-400 text-sm"><span className="mr-3 text-white">✓</span> Community support</div>
                </div>
                <button onClick={() => navigate('/onboarding')} className="w-full bg-white/5 text-white py-4 rounded-full font-medium hover:bg-white/10 transition-colors border border-white/10">Deploy Local</button>
             </div>
             
             <div className="border border-white p-10 rounded-[2.5rem] bg-black shadow-[0_0_80px_rgba(255,255,255,0.05)] relative transform md:-translate-y-4">
                <div className="absolute -top-4 left-10 bg-white text-black text-xs font-bold uppercase tracking-widest py-1.5 px-4 rounded-full">The Standard</div>
                <h3 className="text-2xl font-serif font-medium mb-2 text-white">Truth Elite</h3>
                <div className="text-5xl font-serif mb-8 text-white">$500<span className="text-xl text-zinc-500 font-sans tracking-normal">/mo</span></div>
                <p className="text-zinc-300 font-light mb-8 h-12">Total, unmetered access to the aggregation engine.</p>
                <div className="space-y-4 mb-12">
                  <div className="flex items-center text-zinc-300 text-sm"><span className="mr-3 text-white">✓</span> Zero configuration required</div>
                  <div className="flex items-center text-zinc-300 text-sm"><span className="mr-3 text-white">✓</span> Unlimited parallel queries</div>
                  <div className="flex items-center text-zinc-300 text-sm"><span className="mr-3 text-white">✓</span> All flagship models included</div>
                  <div className="flex items-center text-zinc-300 text-sm"><span className="mr-3 text-white">✓</span> Dedicated white-glove support</div>
                </div>
                <button onClick={() => navigate('/onboarding')} className="w-full bg-white text-black py-4 rounded-full font-medium hover:scale-[1.02] transition-all shadow-lg">Secure Access</button>
             </div>
             
             <div className="border border-white/10 p-10 rounded-[2.5rem] bg-zinc-950/50 hover:bg-zinc-950 transition-colors">
                <h3 className="text-2xl font-serif font-medium mb-2 text-white">Sovereign</h3>
                <div className="text-5xl font-serif mb-8 text-white">Custom</div>
                <p className="text-zinc-400 font-light mb-8 h-12">On-premise deployment for strict data compliance.</p>
                <div className="space-y-4 mb-12">
                  <div className="flex items-center text-zinc-400 text-sm"><span className="mr-3 text-white">✓</span> Air-gapped capabilities</div>
                  <div className="flex items-center text-zinc-400 text-sm"><span className="mr-3 text-white">✓</span> Advanced permission routing</div>
                  <div className="flex items-center text-zinc-400 text-sm"><span className="mr-3 text-white">✓</span> Custom weights & fine-tunes</div>
                </div>
                <button onClick={() => navigate('/onboarding')} className="w-full bg-white/5 text-white py-4 rounded-full font-medium hover:bg-white/10 transition-colors border border-white/10">Contact Firm</button>
             </div>
          </div>
        </motion.section>
      </main>

      {/* Footer */}
      <footer className="border-t border-white/10 py-12 px-8">
        <div className="max-w-[1400px] mx-auto flex flex-col md:flex-row justify-between items-center text-sm text-zinc-500 space-y-4 md:space-y-0">
          <div className="font-mono tracking-wider text-xs">TRUTH SYSTEMS // RUNTIME SECURE.</div>
          <div className="flex space-x-8 tracking-wide">
            <a href="#" className="hover:text-white transition-colors">Intelligence</a>
            <a href="#" className="hover:text-white transition-colors">Privacy</a>
            <a href="#" className="hover:text-white transition-colors">Terms</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
