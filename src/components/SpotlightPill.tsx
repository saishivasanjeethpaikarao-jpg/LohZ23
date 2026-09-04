import React, { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  Search,
  Mic,
  MicOff,
  Send,
  X,
  Globe,
  Sparkles,
  Terminal,
  Volume2,
  VolumeX,
  Laptop,
  ArrowRight,
  CornerDownLeft,
  Loader2,
  CheckCircle2,
  ExternalLink
} from "lucide-react";
import { useAuth } from "../contexts/AuthContext";
import { speechService } from "../lib/speechSynthesis";

interface SpotlightPillProps {
  themeColor?: string;
}

const QUICK_ACTIONS = [
  { id: "vscode", label: "Open VS Code", query: "open vs code", icon: Terminal, color: "text-blue-400" },
  { id: "youtube", label: "YouTube on Chrome", query: "open youtube on chrome", icon: Globe, color: "text-red-400" },
  { id: "search_yt", label: "Search YouTube: Chill Lofi", query: "search youtube for lofi beats", icon: Search, color: "text-amber-400" },
  { id: "screenshot", label: "Take Screenshot", query: "take a screenshot", icon: Laptop, color: "text-emerald-400" },
  { id: "mute", label: "Mute Volume", query: "mute the volume", icon: VolumeX, color: "text-purple-400" },
  { id: "sysinfo", label: "System Hardware Specs", query: "system info", icon: Laptop, color: "text-cyan-400" },
];

export const SpotlightPill: React.FC<SpotlightPillProps> = ({ themeColor = "violet" }) => {
  const { getIdToken } = useAuth();
  const [query, setQuery] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const [isVoiceActive, setIsVoiceActive] = useState(false);
  const [result, setResult] = useState<{
    text: string;
    toolUsed?: string | null;
    success?: boolean;
    url?: string;
  } | null>(null);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const getAuthHeaders = useCallback(async (): Promise<Record<string, string>> => {
    try {
      const token = await getIdToken();
      if (token) return { Authorization: `Bearer ${token}` };
    } catch { /* fail closed */ }
    return import.meta.env.DEV ? { "X-LOHZ-Dev-Uid": "local-development" } : {};
  }, [getIdToken]);

  const updateHeight = useCallback((height: number) => {
    const desktop = (window as any).lohzDesktop;
    if (desktop?.resizePill) {
      desktop.resizePill(height);
    }
  }, []);

  const handleClose = useCallback(() => {
    const desktop = (window as any).lohzDesktop;
    if (desktop?.hidePill) {
      desktop.hidePill();
    }
    setQuery("");
    setResult(null);
    setShowSuggestions(false);
    updateHeight(76);
  }, [updateHeight]);

  // Adjust window height when suggestions or results appear
  useEffect(() => {
    if (result) {
      updateHeight(220);
    } else if (showSuggestions && query.trim().length > 0) {
      updateHeight(280);
    } else if (showSuggestions) {
      updateHeight(260);
    } else {
      updateHeight(76);
    }
  }, [result, showSuggestions, query, updateHeight]);

  // Listen for desktop:pill-shown to auto-focus
  useEffect(() => {
    const desktop = (window as any).lohzDesktop;
    if (desktop?.onPillShown) {
      const cleanup = desktop.onPillShown(() => {
        setQuery("");
        setResult(null);
        setShowSuggestions(true);
        inputRef.current?.focus();
      });
      return cleanup;
    }
  }, []);

  // Global Escape handler
  useEffect(() => {
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        handleClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleClose]);

  const handleExecute = async (commandText: string) => {
    const text = commandText.trim();
    if (!text || isProcessing) return;

    setIsProcessing(true);
    setResult(null);

    try {
      const headers = await getAuthHeaders();
      const res = await fetch("/api/route", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ text }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Command execution failed.");

      const reply = data.response || "Command executed successfully.";
      const targetUrl = (data.result as any)?.data?.url || (data.result as any)?.url;

      setResult({
        text: reply,
        toolUsed: data.toolUsed,
        success: data.success ?? true,
        url: targetUrl,
      });

      // Speak response aloud through companion voice engine
      speechService.speak(reply);
    } catch (err: any) {
      setResult({
        text: err?.message || "An unexpected error occurred while executing the command.",
        success: false,
      });
    } finally {
      setIsProcessing(false);
    }
  };

  const handleVoiceToggle = () => {
    if (!("webkitSpeechRecognition" in window || "SpeechRecognition" in window)) {
      alert("Voice recognition is not supported in this browser engine.");
      return;
    }

    if (isVoiceActive) {
      setIsVoiceActive(false);
      return;
    }

    const SpeechRec = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    const recognition = new SpeechRec();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = "en-US";

    recognition.onstart = () => setIsVoiceActive(true);
    recognition.onend = () => setIsVoiceActive(false);
    recognition.onerror = () => setIsVoiceActive(false);
    recognition.onresult = (event: any) => {
      const transcript = event.results[0]?.[0]?.transcript;
      if (transcript) {
        setQuery(transcript);
        handleExecute(transcript);
      }
    };

    recognition.start();
  };

  const themeGlow = {
    violet: "from-purple-500/30 via-violet-500/20 to-indigo-500/30 border-violet-400/40 shadow-[0_0_40px_rgba(168,85,247,0.3)]",
    crimson: "from-rose-500/30 via-red-500/20 to-orange-500/30 border-rose-400/40 shadow-[0_0_40px_rgba(244,63,94,0.3)]",
    emerald: "from-emerald-500/30 via-teal-500/20 to-cyan-500/30 border-emerald-400/40 shadow-[0_0_40px_rgba(16,185,129,0.3)]",
    celestial: "from-sky-500/30 via-blue-500/20 to-cyan-500/30 border-sky-400/40 shadow-[0_0_40px_rgba(14,165,233,0.3)]",
    gold: "from-amber-500/30 via-yellow-500/20 to-orange-500/30 border-amber-400/40 shadow-[0_0_40px_rgba(245,158,11,0.3)]",
  }[themeColor] || "from-purple-500/30 via-violet-500/20 to-indigo-500/30 border-violet-400/40 shadow-[0_0_40px_rgba(168,85,247,0.3)]";

  return (
    <div className="w-full h-screen flex flex-col items-center justify-start p-2 bg-transparent select-none">
      <div
        className={`w-full max-w-[660px] rounded-2xl bg-slate-950/85 backdrop-blur-2xl border ${themeGlow} transition-all duration-300 overflow-hidden flex flex-col`}
      >
        {/* Top Input Bar */}
        <div className="flex items-center gap-3 px-4 py-3 h-[60px]">
          <div className="flex items-center justify-center w-7 h-7 rounded-xl bg-gradient-to-tr from-cyan-500 to-indigo-500 text-white shadow-md shrink-0">
            <Sparkles size={15} className="animate-pulse" />
          </div>

          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setResult(null);
              setShowSuggestions(true);
            }}
            onFocus={() => setShowSuggestions(true)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                handleExecute(query);
              }
            }}
            placeholder="Ask LOHZ, launch an app, search YouTube, or mute volume..."
            className="flex-1 bg-transparent border-none outline-none text-sm text-slate-100 placeholder-slate-400 font-sans tracking-wide"
            autoFocus
          />

          <div className="flex items-center gap-1.5 shrink-0">
            <button
              onClick={handleVoiceToggle}
              className={`p-2 rounded-xl transition-all cursor-pointer ${
                isVoiceActive
                  ? "bg-cyan-500/20 border border-cyan-400 text-cyan-300 animate-pulse"
                  : "hover:bg-white/10 text-slate-400 hover:text-white"
              }`}
              title={isVoiceActive ? "Listening..." : "Click to speak"}
              aria-label="Voice input"
            >
              {isVoiceActive ? <Mic size={15} /> : <MicOff size={15} />}
            </button>

            {query.trim() && (
              <button
                onClick={() => handleExecute(query)}
                disabled={isProcessing}
                className="p-2 rounded-xl bg-indigo-500/80 hover:bg-indigo-500 text-white transition-all cursor-pointer disabled:opacity-50"
                title="Execute (Enter)"
                aria-label="Execute command"
              >
                {isProcessing ? <Loader2 size={15} className="animate-spin" /> : <CornerDownLeft size={15} />}
              </button>
            )}

            <button
              onClick={handleClose}
              className="p-2 rounded-xl hover:bg-white/10 text-slate-400 hover:text-white transition-all cursor-pointer"
              title="Close (Escape)"
              aria-label="Close Spotlight"
            >
              <X size={15} />
            </button>
          </div>
        </div>

        {/* Results Card */}
        <AnimatePresence>
          {result && (
            <motion.div
              key="pill-result-card"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="border-t border-white/10 p-4 bg-slate-900/60 flex flex-col gap-2"
            >
              <div className="flex items-center gap-2 text-xs font-mono">
                <CheckCircle2 size={14} className={result.success ? "text-emerald-400" : "text-amber-400"} />
                <span className="text-slate-300 uppercase tracking-wider font-semibold">
                  {result.toolUsed ? `TOOL: ${result.toolUsed}` : "LOHZ RESPONSE"}
                </span>
                {result.url && (
                  <a
                    href={result.url}
                    target="_blank"
                    rel="noreferrer"
                    className="ml-auto flex items-center gap-1 text-[11px] text-cyan-400 hover:underline"
                  >
                    <span>View Link</span>
                    <ExternalLink size={12} />
                  </a>
                )}
              </div>
              <p className="text-xs text-slate-200 leading-relaxed font-sans select-text">
                {result.text}
              </p>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Action Suggestion Chips */}
        <AnimatePresence>
          {showSuggestions && !result && (
            <motion.div
              key="pill-suggestions"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="border-t border-white/10 p-3 bg-slate-900/40 flex flex-col gap-1.5"
            >
              <span className="text-[10px] font-mono uppercase tracking-widest text-slate-400 px-1 mb-1">
                Quick Action Triggers
              </span>
              <div className="grid grid-cols-2 gap-1.5">
                {QUICK_ACTIONS.map((action) => {
                  const Icon = action.icon;
                  return (
                    <button
                      key={action.id}
                      onClick={() => {
                        setQuery(action.query);
                        handleExecute(action.query);
                      }}
                      className="flex items-center gap-2.5 px-3 py-2 rounded-xl bg-white/5 hover:bg-white/10 border border-white/5 transition-all text-left group cursor-pointer"
                    >
                      <Icon size={14} className={`${action.color} group-hover:scale-110 transition-transform`} />
                      <span className="text-xs text-slate-200 group-hover:text-white font-sans truncate">
                        {action.label}
                      </span>
                      <ArrowRight size={12} className="ml-auto text-slate-400 opacity-0 group-hover:opacity-100 transition-opacity" />
                    </button>
                  );
                })}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
};
