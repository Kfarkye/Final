import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'motion/react';
import { googleSignIn, db } from './lib/firebase';
import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore';

export default function Onboarding() {
  const navigate = useNavigate();
  const [step, setStep] = useState(1);
  const [isAgeVerified, setIsAgeVerified] = useState(false);
  const [workspaceDomain, setWorkspaceDomain] = useState('');
  const [baseModel, setBaseModel] = useState('');
  const [isAuthenticating, setIsAuthenticating] = useState(false);

  const nextStep = () => setStep(s => s + 1);

  const handleAuth = async () => {
    if (!baseModel) return;
    setIsAuthenticating(true);
    try {
      const cleanDomain = workspaceDomain.trim().toLowerCase();
      const result = await googleSignIn(cleanDomain || undefined);
      if (!result) throw new Error("No user returned");
      const user = result.user;
      
      const userDocRef = doc(db, 'users', user.uid);
      const userDoc = await getDoc(userDocRef);
      
      if (!userDoc.exists()) {
        await setDoc(userDocRef, {
          email: user.email || '',
          baseModel: baseModel,
          role: 'Admin',
          createdAt: serverTimestamp()
        });
      } else {
        // Update user preference if they login again
        await setDoc(userDocRef, { baseModel }, { merge: true });
      }
      
      sessionStorage.setItem('truthConfig', JSON.stringify({ baseModel }));
      navigate('/chat');
    } catch (error) {
      console.error("Login failed", error);
      alert("Failed to authenticate.");
    } finally {
      setIsAuthenticating(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-6 bg-black text-white font-sans selection:bg-zinc-800">
      <div className="w-full max-w-2xl bg-zinc-950 p-12 flex flex-col rounded-[2.5rem] shadow-2xl border border-white/10 overflow-hidden relative">
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-full h-[1px] bg-gradient-to-r from-transparent via-white/20 to-transparent"></div>
        <AnimatePresence mode="wait">
        {step === 1 && (
          <motion.div 
            key="step1"
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
          >
            <h2 className="text-3xl font-serif font-medium mb-8 tracking-tight">Terms & Privacy.</h2>
            <div className="space-y-6 text-zinc-400 font-light text-lg mb-10 leading-relaxed">
              <p>
                Truth sends your prompts to multiple models concurrently. 
              </p>
              <p className="font-medium text-white bg-white/5 p-6 rounded-2xl border border-white/10 backdrop-blur-sm">
                You acknowledge that AI models can produce inaccurate or biased content. Do not rely on output for medical, legal, or financial decisions without verification.
              </p>
              <label className="flex items-center space-x-4 cursor-pointer mt-8">
                <input 
                  type="checkbox" 
                  className="w-5 h-5 rounded border-white/20 bg-black text-white focus:ring-1 focus:ring-white/50 focus:ring-offset-0 focus:border-white transition-all cursor-pointer" 
                  id="age-gate" 
                  checked={isAgeVerified}
                  onChange={(e) => setIsAgeVerified(e.target.checked)} 
                />
                <span className="text-sm">I have read and agree to the <a href="#" className="underline hover:text-white transition-colors">Terms of Service</a>.</span>
              </label>
            </div>
            <button 
              onClick={nextStep} 
              disabled={!isAgeVerified} 
              className="w-full bg-white text-black py-4 rounded-full font-medium tracking-wide disabled:opacity-30 disabled:cursor-not-allowed hover:bg-zinc-200 transition-colors shadow-[0_0_20px_rgba(255,255,255,0.1)] hover:shadow-[0_0_30px_rgba(255,255,255,0.2)]"
            >
              Continue
            </button>
          </motion.div>
        )}

        {step === 2 && (
          <motion.div 
            key="step2"
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
          >
            <h2 className="text-3xl font-serif font-medium mb-4 tracking-tight">Enterprise Configuration.</h2>
            <p className="text-zinc-400 mb-6 font-light text-lg">Configure your workspace SSO and primary baseline.</p>
            
            <div className="mb-6 space-y-2">
              <label className="text-xs uppercase tracking-widest font-semibold text-zinc-500">Google Workspace SSO Domain (Optional)</label>
              <div className="relative">
                <input 
                  type="text" 
                  value={workspaceDomain}
                  onChange={(e) => setWorkspaceDomain(e.target.value)}
                  placeholder="e.g. acmecorp.com"
                  className="w-full bg-black border border-white/10 rounded-xl px-4 py-3 text-white placeholder-zinc-700 focus:border-white/30 focus:outline-none focus:ring-1 focus:ring-white/30 transition-all font-mono text-sm"
                />
              </div>
            </div>

            <div className="mb-4">
              <label className="text-xs uppercase tracking-widest font-semibold text-zinc-500">Primary Baseline Model</label>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-10">
              {[
                { id: 'gemini', name: 'Gemini 3.5 Flash' },
                { id: 'chatgpt', name: 'GPT 5.5' },
                { id: 'claude', name: 'Claude 4.8 Opus' },
                { id: 'grok', name: 'Grok 4.3' },
                { id: 'deepseek', name: 'DeepSeek V4 Pro' }
              ].map(model => (
                <button
                  key={model.id}
                  onClick={() => setBaseModel(model.id)}
                  className={`p-6 text-left rounded-2xl border transition-all duration-300 ${baseModel === model.id ? 'border-white bg-white/10 ring-1 ring-white shadow-[0_0_15px_rgba(255,255,255,0.1)]' : 'border-white/10 hover:border-white/30 hover:bg-white/5'}`}
                >
                  <div className="font-medium text-lg text-white">{model.name}</div>
                </button>
              ))}
            </div>
            <button 
              onClick={handleAuth} 
              disabled={!baseModel || isAuthenticating}
              className="w-full bg-white text-black py-4 rounded-full font-medium tracking-wide disabled:opacity-30 hover:bg-zinc-200 transition-colors shadow-[0_0_20px_rgba(255,255,255,0.1)] hover:shadow-[0_0_30px_rgba(255,255,255,0.2)] flex justify-center items-center"
            >
              {isAuthenticating ? (
                <div className="w-5 h-5 border-2 border-black/20 border-t-black rounded-full animate-spin" />
              ) : (
                "Continue with Google"
              )}
            </button>
          </motion.div>
        )}
        </AnimatePresence>
      </div>
    </div>
  );
}
