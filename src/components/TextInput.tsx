import { useState, useRef, useEffect, KeyboardEvent, ChangeEvent } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Send, Loader2, MessageCircle, Mic, MicOff, X } from "lucide-react";

export interface TextInputProps {
  isVisible: boolean;
  onSend: (text: string) => void;
  onToggleVoice: () => void;
  isVoiceActive: boolean;
  isProcessing: boolean;
  isThinking: boolean;
  placeholder?: string;
  themeColor?: string;
}

export function TextInput({
  isVisible,
  onSend,
  onToggleVoice,
  isVoiceActive,
  isProcessing,
  isThinking,
  placeholder = "Type a message to LOHZ...",
  themeColor = "violet",
}: TextInputProps) {
  const [text, setText] = useState<string>("");
  const [isFocused, setIsFocused] = useState<boolean>(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const themeAccent = {
    violet: "border-violet-400/30 focus-within:border-violet-300/60 focus-within:shadow-[0_0_24px_rgba(168,85,247,0.25)]",
    crimson: "border-rose-400/30 focus-within:border-rose-300/60 focus-within:shadow-[0_0_24px_rgba(244,63,94,0.25)]",
    emerald: "border-emerald-400/30 focus-within:border-emerald-300/60 focus-within:shadow-[0_0_24px_rgba(16,185,129,0.25)]",
    celestial: "border-sky-400/30 focus-within:border-sky-300/60 focus-within:shadow-[0_0_24px_rgba(14,165,233,0.25)]",
    gold: "border-amber-400/30 focus-within:border-amber-300/60 focus-within:shadow-[0_0_24px_rgba(245,158,11,0.25)]",
    rose: "border-pink-400/30 focus-within:border-pink-300/60 focus-within:shadow-[0_0_24px_rgba(244,114,182,0.25)]",
    charcoal: "border-indigo-400/30 focus-within:border-indigo-300/60 focus-within:shadow-[0_0_24px_rgba(99,102,241,0.25)]",
  }[themeColor] || "border-violet-400/30";

  const handleSubmit = () => {
    const trimmed = text.trim();
    if (!trimmed || isProcessing) return;
    onSend(trimmed);
    setText("");
    inputRef.current?.focus();
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value);
    if (inputRef.current) {
      inputRef.current.style.height = "auto";
      inputRef.current.style.height = Math.min(inputRef.current.scrollHeight, 120) + "px";
    }
  };

  useEffect(() => {
    if (isVisible && !isProcessing) {
      inputRef.current?.focus();
    }
  }, [isVisible, isProcessing]);

  return (
    <AnimatePresence>
      {isVisible && (
        <motion.div
          initial={{ opacity: 0, y: 30, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 30, scale: 0.96 }}
          transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
          className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 w-full max-w-2xl px-4 pointer-events-none"
          data-testid="text-input"
        >
          <div
            className={`flex items-end gap-2 p-3 rounded-2xl border ${themeAccent} bg-slate-950/75 backdrop-blur-2xl shadow-2xl transition-all duration-300 pointer-events-auto`}
          >
            <button
              onClick={onToggleVoice}
              className={`shrink-0 p-2.5 rounded-xl transition-all duration-200 cursor-pointer ${
                isVoiceActive
                  ? "bg-cyan-500/20 border border-cyan-400/60 text-cyan-200 shadow-[0_0_15px_rgba(34,211,238,0.3)]"
                  : "bg-white/5 border border-white/10 text-slate-400 hover:text-white hover:bg-white/10"
              }`}
              aria-label={isVoiceActive ? "Stop voice input" : "Start voice input"}
              title={isVoiceActive ? "Stop voice input" : "Start voice input"}
            >
              {isVoiceActive ? <Mic size={16} /> : <MicOff size={16} />}
            </button>

            <textarea
              ref={inputRef}
              value={text}
              onChange={handleChange}
              onKeyDown={handleKeyDown}
              onFocus={() => setIsFocused(true)}
              onBlur={() => setIsFocused(false)}
              placeholder={placeholder}
              rows={1}
              disabled={isProcessing}
              className="flex-1 bg-transparent border-0 outline-none resize-none text-white placeholder:text-white/30 text-sm font-sans py-2 px-2 max-h-[120px] disabled:opacity-50"
              style={{ height: "36px" }}
              data-testid="text-input-textarea"
            />

            {isProcessing || isThinking ? (
              <div className="shrink-0 p-2.5 flex items-center gap-2">
                <Loader2 size={16} className="animate-spin text-cyan-300" />
                <span className="text-xs font-mono text-white/60 tracking-wide">
                  {isThinking ? "THINKING..." : "TRANSMITTING..."}
                </span>
              </div>
            ) : (
              <button
                onClick={handleSubmit}
                disabled={!text.trim()}
                className="shrink-0 p-2.5 rounded-xl transition-all duration-200 cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed bg-violet-500/80 hover:bg-violet-400 border border-violet-300/50 text-white shadow-[0_0_18px_rgba(168,85,247,0.35)] disabled:shadow-none"
                aria-label="Send message"
                title="Send (Enter)"
                data-testid="text-input-send"
              >
                <Send size={16} />
              </button>
            )}
          </div>

          {isFocused && (
            <motion.div
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              className="absolute -top-7 left-1/2 -translate-x-1/2 text-[10px] font-mono tracking-widest uppercase text-white/40 pointer-events-none"
            >
              <span>Enter to send · Shift+Enter for new line</span>
            </motion.div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export default TextInput;