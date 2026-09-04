import React, { useEffect, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  GitBranch,
  Bug,
  Palette,
  FileCode2,
  Globe,
  X,
  ArrowRight,
  ClipboardCheck
} from "lucide-react";
import { ClipboardActionChip } from "../lib/clipboardSentinel";

interface ClipboardSentinelChipProps {
  chip: ClipboardActionChip | null;
  onDismiss: () => void;
}

export const ClipboardSentinelChip: React.FC<ClipboardSentinelChipProps> = ({
  chip,
  onDismiss,
}) => {
  const [progress, setProgress] = useState(100);

  // Auto-dismiss after 8 seconds with smooth visual progress bar
  useEffect(() => {
    if (!chip) return;
    setProgress(100);
    const start = Date.now();
    const duration = 8000;

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
  }, [chip, onDismiss]);

  if (!chip) return null;

  const getIcon = () => {
    switch (chip.type) {
      case "git_repo":
        return <GitBranch size={16} className="text-blue-400" />;
      case "error_stack":
        return <Bug size={16} className="text-rose-400" />;
      case "hex_color":
        return <Palette size={16} className="text-amber-400" />;
      case "json_data":
        return <FileCode2 size={16} className="text-purple-400" />;
      case "youtube_url":
      case "general_url":
      default:
        return <Globe size={16} className="text-cyan-400" />;
    }
  };

  const getBorderColor = () => {
    switch (chip.type) {
      case "git_repo":
        return "border-blue-500/30 shadow-[0_0_25px_rgba(59,130,246,0.25)]";
      case "error_stack":
        return "border-rose-500/30 shadow-[0_0_25px_rgba(244,63,94,0.25)]";
      case "hex_color":
        return "border-amber-500/30 shadow-[0_0_25px_rgba(245,158,11,0.25)]";
      case "json_data":
        return "border-purple-500/30 shadow-[0_0_25px_rgba(168,85,247,0.25)]";
      default:
        return "border-cyan-500/30 shadow-[0_0_25px_rgba(34,211,238,0.25)]";
    }
  };

  return (
    <AnimatePresence>
      <motion.div
        key={`sentinel-${chip.id}`}
        initial={{ opacity: 0, y: 30, scale: 0.92 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 20, scale: 0.95 }}
        transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
        className={`fixed bottom-8 right-8 z-50 w-84 rounded-2xl bg-slate-950/90 backdrop-blur-2xl border ${getBorderColor()} overflow-hidden select-none p-3.5 flex flex-col gap-2.5 pointer-events-auto`}
      >
        {/* Header with Icon, Category badge, and Close */}
        <div className="flex items-center gap-2.5">
          <div className="p-2 rounded-xl bg-white/5 border border-white/5 shrink-0">
            {getIcon()}
          </div>
          <div className="flex flex-col min-w-0 flex-1">
            <span className="text-[10px] font-mono uppercase tracking-wider text-slate-400 flex items-center gap-1">
              <ClipboardCheck size={10} className="text-cyan-400" />
              <span>CLIPBOARD SENTINEL</span>
            </span>
            <h4 className="text-xs font-semibold text-slate-100 truncate font-sans">
              {chip.title}
            </h4>
          </div>
          <button
            onClick={onDismiss}
            className="p-1 rounded-lg hover:bg-white/10 text-slate-400 hover:text-white transition cursor-pointer shrink-0"
            aria-label="Dismiss chip"
          >
            <X size={14} />
          </button>
        </div>

        {/* Subtitle / preview snippet */}
        <p className="text-[11px] text-slate-300 line-clamp-1 font-mono pl-0.5">
          {chip.subtitle}
        </p>

        {/* Action Button */}
        <button
          onClick={() => {
            chip.execute();
            onDismiss();
          }}
          className="flex items-center justify-between px-3 py-2 rounded-xl bg-white/10 hover:bg-white/15 border border-white/10 text-slate-100 text-xs font-sans font-medium transition-all group cursor-pointer"
        >
          <span>{chip.actionText}</span>
          <ArrowRight size={13} className="text-slate-400 group-hover:translate-x-1 group-hover:text-white transition-all" />
        </button>

        {/* Countdown progress bar */}
        <div className="w-full h-0.5 bg-white/10 rounded-full overflow-hidden">
          <div
            className="h-full bg-cyan-400/80 transition-all duration-100"
            style={{ width: `${progress}%` }}
          />
        </div>
      </motion.div>
    </AnimatePresence>
  );
};
