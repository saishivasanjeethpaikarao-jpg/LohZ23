import React, { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { 
  MessageSquare, 
  X, 
  Volume2, 
  Mic, 
  Trash2, 
  Download, 
  ChevronDown,
  ChevronUp,
  Pause,
  Play,
} from "lucide-react";

export interface TranscriptEntry {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  timestamp: number;
  emotion?: string;
  toolUsed?: string;
  isFinal?: boolean;
}

export interface TranscriptionPanelProps {
  isOpen: boolean;
  onClose: () => void;
  entries: TranscriptEntry[];
  onClear: () => void;
  isLive: boolean;
  isThinking: boolean;
  themeColor?: string;
}

export function TranscriptionPanel({
  isOpen,
  onClose,
  entries,
  onClear,
  isLive,
  isThinking,
  themeColor = "violet",
}: TranscriptionPanelProps) {
  const [isCollapsed, setIsCollapsed] = useState<boolean>(false);
  const [autoScroll, setAutoScroll] = useState<boolean>(true);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const themeAccent = {
    violet: { border: "border-violet-400/20", glow: "shadow-[0_0_30px_rgba(168,85,247,0.15)]", text: "text-violet-300", accent: "bg-violet-500/20" },
    crimson: { border: "border-rose-400/20", glow: "shadow-[0_0_30px_rgba(244,63,94,0.15)]", text: "text-rose-300", accent: "bg-rose-500/20" },
    emerald: { border: "border-emerald-400/20", glow: "shadow-[0_0_30px_rgba(16,185,129,0.15)]", text: "text-emerald-300", accent: "bg-emerald-500/20" },
    celestial: { border: "border-sky-400/20", glow: "shadow-[0_0_30px_rgba(14,165,233,0.15)]", text: "text-sky-300", accent: "bg-sky-500/20" },
    gold: { border: "border-amber-400/20", glow: "shadow-[0_0_30px_rgba(245,158,11,0.15)]", text: "text-amber-300", accent: "bg-amber-500/20" },
    rose: { border: "border-pink-400/20", glow: "shadow-[0_0_30px_rgba(244,114,182,0.15)]", text: "text-pink-300", accent: "bg-pink-500/20" },
    charcoal: { border: "border-indigo-400/20", glow: "shadow-[0_0_30px_rgba(99,102,241,0.15)]", text: "text-indigo-300", accent: "bg-indigo-500/20" },
  }[themeColor] || { border: "border-violet-400/20", glow: "shadow-[0_0_30px_rgba(168,85,247,0.15)]", text: "text-violet-300", accent: "bg-violet-500/20" };

  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [entries, autoScroll]);

  const handleExport = () => {
    const text = entries
      .map(e => {
        const time = new Date(e.timestamp).toLocaleTimeString();
        const label = e.role === "user" ? "USER" : e.role === "assistant" ? "LOHZ" : "SYSTEM";
        return `[${time}] ${label}: ${e.text}`;
      })
      .join("\n");
    
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `lohz-transcript-${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleScroll = () => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    const atBottom = scrollHeight - scrollTop - clientHeight < 50;
    setAutoScroll(atBottom);
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0, y: 40, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 40, scale: 0.96 }}
          transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
          className={`fixed left-4 right-4 md:left-6 md:right-auto md:w-[420px] z-30 pointer-events-none ${isCollapsed ? "bottom-20" : "bottom-32"}`}
          style={{ transition: "bottom 0.3s ease" }}
          data-testid="transcription-panel"
        >
          <div
            className={`pointer-events-auto rounded-2xl border ${themeAccent.border} ${themeAccent.glow} bg-slate-950/80 backdrop-blur-2xl overflow-hidden shadow-2xl`}
          >
            <button
              onClick={() => setIsCollapsed(c => !c)}
              className="w-full flex items-center justify-between p-3 hover:bg-white/5 transition cursor-pointer"
              aria-label={isCollapsed ? "Expand transcript" : "Collapse transcript"}
            >
              <div className="flex items-center gap-2">
                <div className={`p-1.5 rounded-lg ${themeAccent.accent}`}>
                  <MessageSquare size={14} className={themeAccent.text} />
                </div>
                <div className="flex flex-col text-left">
                  <span className={`text-xs font-bold font-mono tracking-wider ${themeAccent.text}`}>
                    TRANSCRIPTION
                  </span>
                  <span className="text-[9px] font-mono text-white/40 tracking-wider uppercase">
                    {entries.length} entries · {isLive ? "LIVE" : "IDLE"}
                    {isThinking && " · THINKING"}
                  </span>
                </div>
              </div>

              <div className="flex items-center gap-1">
                {isLive && (
                  <span className="flex items-center gap-1 text-[9px] font-mono text-emerald-300 mr-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                    LIVE
                  </span>
                )}
                {isCollapsed ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              </div>
            </button>

            <AnimatePresence initial={false}>
              {!isCollapsed && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.25 }}
                  className="overflow-hidden"
                >
                  <div
                    ref={scrollRef}
                    onScroll={handleScroll}
                    className="max-h-[280px] overflow-y-auto px-3 pb-3 space-y-2"
                    data-testid="transcription-entries"
                  >
                    {entries.length === 0 ? (
                      <div className="text-center py-6">
                        <p className="text-xs font-mono text-white/30 uppercase tracking-widest">
                          No transcripts yet
                        </p>
                        <p className="text-[10px] text-white/20 mt-1">
                          Speak or type to start conversation
                        </p>
                      </div>
                    ) : (
                      entries.map((entry) => (
                        <TranscriptEntryRow
                          key={entry.id}
                          entry={entry}
                          themeAccent={themeAccent}
                        />
                      ))
                    )}
                    
                    {isThinking && (
                      <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        className="flex items-center gap-2 px-3 py-2 rounded-xl bg-white/3 border border-white/5"
                      >
                        <div className="flex gap-1">
                          <span className="w-1 h-1 rounded-full bg-white/40 animate-bounce" style={{ animationDelay: "0ms" }} />
                          <span className="w-1 h-1 rounded-full bg-white/40 animate-bounce" style={{ animationDelay: "150ms" }} />
                          <span className="w-1 h-1 rounded-full bg-white/40 animate-bounce" style={{ animationDelay: "300ms" }} />
                        </div>
                        <span className="text-[10px] font-mono text-white/50 uppercase tracking-wider">
                          LOHZ is thinking...
                        </span>
                      </motion.div>
                    )}
                  </div>

                  <div className="flex items-center justify-between p-2 border-t border-white/5 bg-slate-950/40">
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => setAutoScroll(a => !a)}
                        className={`p-1.5 rounded-lg text-[10px] font-mono uppercase tracking-wider transition cursor-pointer ${
                          autoScroll ? `${themeAccent.text} bg-white/5` : "text-white/40 hover:text-white/60"
                        }`}
                        title={autoScroll ? "Auto-scroll: ON" : "Auto-scroll: OFF"}
                      >
                        {autoScroll ? "AUTO" : "MANUAL"}
                      </button>
                      <button
                        onClick={onClear}
                        disabled={entries.length === 0}
                        className="p-1.5 rounded-lg text-white/40 hover:text-rose-300 hover:bg-rose-500/10 disabled:opacity-30 disabled:cursor-not-allowed transition cursor-pointer"
                        title="Clear transcripts"
                      >
                        <Trash2 size={12} />
                      </button>
                      <button
                        onClick={handleExport}
                        disabled={entries.length === 0}
                        className="p-1.5 rounded-lg text-white/40 hover:text-cyan-300 hover:bg-cyan-500/10 disabled:opacity-30 disabled:cursor-not-allowed transition cursor-pointer"
                        title="Export transcripts"
                      >
                        <Download size={12} />
                      </button>
                    </div>
                    <button
                      onClick={onClose}
                      className="p-1.5 rounded-lg text-white/40 hover:text-white hover:bg-white/10 transition cursor-pointer"
                      title="Close panel"
                    >
                      <X size={12} />
                    </button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

interface TranscriptEntryRowProps {
  key?: React.Key;
  entry: TranscriptEntry;
  themeAccent: { border: string; glow: string; text: string; accent: string };
}

function TranscriptEntryRow({ entry, themeAccent }: TranscriptEntryRowProps) {
  const time = new Date(entry.timestamp).toLocaleTimeString([], { 
    hour: "2-digit", 
    minute: "2-digit",
    second: "2-digit"
  });

  if (entry.role === "system") {
    return (
      <div className="flex items-center justify-center gap-2 py-1.5 px-2 text-[10px] font-mono text-white/30 uppercase tracking-widest">
        <span className="h-px w-8 bg-white/10" />
        <span>{entry.text}</span>
        <span className="h-px w-8 bg-white/10" />
      </div>
    );
  }

  const isUser = entry.role === "user";

  return (
    <motion.div
      initial={{ opacity: 0, x: isUser ? 8 : -8, scale: 0.98 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      transition={{ duration: 0.3 }}
      className={`flex flex-col ${isUser ? "items-end" : "items-start"} gap-0.5`}
    >
      <div className="flex items-center gap-1.5 text-[9px] font-mono uppercase tracking-wider text-white/30">
        {isUser ? (
          <Mic size={9} className="text-cyan-300" />
        ) : (
          <Volume2 size={9} className={themeAccent.text} />
        )}
        <span>{isUser ? "YOU" : "LOHZ"}</span>
        {entry.emotion && (
          <span className="text-white/20">· {entry.emotion}</span>
        )}
        {entry.toolUsed && (
          <span className="text-cyan-300/60">· {entry.toolUsed}</span>
        )}
        <span className="text-white/20 ml-1">{time}</span>
        {entry.isFinal === false && (
          <span className="text-amber-300/60 animate-pulse">· transcribing</span>
        )}
      </div>
      <div
        className={`max-w-[85%] px-3 py-2 rounded-xl text-xs leading-relaxed ${
          isUser
            ? "bg-cyan-500/10 border border-cyan-400/20 text-cyan-50 rounded-br-sm"
            : "bg-white/5 border border-white/10 text-white/90 rounded-bl-sm"
        }`}
      >
        {entry.text}
      </div>
    </motion.div>
  );
}

export default TranscriptionPanel;