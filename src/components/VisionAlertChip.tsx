import React, { useEffect, useState } from "react";
import { motion } from "motion/react";
import { Eye, AlertTriangle, ArrowRight, X, Sparkles, Terminal } from "lucide-react";
import type { VisionInspectResult } from "../lib/vision/screenVisionService";

interface VisionAlertChipProps {
  alert: VisionInspectResult | null;
  onDismiss: () => void;
  onFix: (actionPrompt: string) => void;
}

export const VisionAlertChip: React.FC<VisionAlertChipProps> = ({
  alert,
  onDismiss,
  onFix,
}) => {
  const [progress, setProgress] = useState(100);

  useEffect(() => {
    if (!alert) return;
    setProgress(100);
    const start = Date.now();
    const duration = 12000; // 12s display window for vision alerts

    const interval = setInterval(() => {
      const elapsed = Date.now() - start;
      const remaining = Math.max(0, 100 - (elapsed / duration) * 100);
      setProgress(remaining);
      if (remaining <= 0) {
        clearInterval(interval);
        onDismiss();
      }
    }, 100);

    return () => clearInterval(interval);
  }, [alert, onDismiss]);

  if (!alert) return null;

  const fixPrompt = alert.suggestedAction
    ? `Fix this error on my screen: ${alert.summary}. Suggested solution: ${alert.suggestedAction}`
    : `Fix this issue detected on my screen: ${alert.summary}${alert.errorSnippet ? `\nError:\n${alert.errorSnippet}` : ""}`;

  return (
    <motion.div
      key="vision-alert-chip"
      initial={{ opacity: 0, y: 30, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 20, scale: 0.95 }}
      transition={{ duration: 0.25, ease: "easeOut" }}
      className="fixed bottom-20 right-6 z-50 max-w-md w-full pointer-events-auto"
    >
      <div className="relative overflow-hidden rounded-2xl border border-rose-500/30 bg-[#0c101d]/90 p-4 shadow-2xl backdrop-blur-xl transition-all hover:border-rose-400/50">
        {/* Progress bar */}
        <div
          className="absolute top-0 left-0 h-[2px] bg-gradient-to-r from-rose-500 via-amber-400 to-cyan-400 transition-all duration-100"
          style={{ width: `${progress}%` }}
        />

        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-400">
            {alert.errorType === "compiler" ? (
              <Terminal size={18} />
            ) : (
              <AlertTriangle size={18} />
            )}
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5">
                <Eye size={13} className="text-cyan-400 animate-pulse" />
                <span className="text-[11px] font-semibold uppercase tracking-wider text-cyan-400">
                  LOHZ Vision Sentinel
                </span>
                {alert.errorType && (
                  <span className="rounded bg-rose-500/20 px-1.5 py-0.5 text-[10px] font-medium text-rose-300">
                    {alert.errorType}
                  </span>
                )}
              </div>

              <button
                onClick={onDismiss}
                className="rounded p-1 text-slate-400 hover:bg-white/10 hover:text-white transition-colors"
                aria-label="Dismiss alert"
              >
                <X size={14} />
              </button>
            </div>

            <p className="mt-1 text-sm font-medium text-slate-200 line-clamp-2">
              {alert.summary}
            </p>

            {alert.errorSnippet && (
              <div className="mt-2 rounded-lg bg-black/40 border border-white/5 p-2 font-mono text-xs text-rose-300/90 truncate">
                {alert.errorSnippet}
              </div>
            )}

            {alert.suggestedAction && (
              <p className="mt-1.5 text-xs text-emerald-400/90 line-clamp-1">
                <span className="font-semibold">Suggested fix: </span>
                {alert.suggestedAction}
              </p>
            )}

            <div className="mt-3 flex items-center gap-2">
              <button
                onClick={() => {
                  onFix(fixPrompt);
                  onDismiss();
                }}
                className="flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-rose-600 to-indigo-600 px-3 py-1.5 text-xs font-semibold text-white shadow-lg shadow-rose-600/20 hover:from-rose-500 hover:to-indigo-500 transition-all cursor-pointer"
              >
                <Sparkles size={13} />
                <span>Fix with LOHZ</span>
                <ArrowRight size={13} />
              </button>

              <button
                onClick={onDismiss}
                className="rounded-lg px-2.5 py-1.5 text-xs text-slate-400 hover:bg-white/5 hover:text-slate-200 transition-colors cursor-pointer"
              >
                Ignore
              </button>
            </div>
          </div>
        </div>
      </div>
    </motion.div>
  );
};
