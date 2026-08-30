import React, { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";

export interface TooltipProps {
  content: React.ReactNode;
  children: React.ReactNode;
  side?: "top" | "bottom" | "left" | "right" | "auto";
  align?: "start" | "center" | "end";
  delay?: number;
  shortcut?: string;
  badge?: string;
  className?: string;
  disabled?: boolean;
}

export const Tooltip: React.FC<TooltipProps> = ({
  content,
  children,
  side = "top",
  align = "center",
  delay = 180,
  shortcut,
  badge,
  className = "",
  disabled = false
}) => {
  const [isVisible, setIsVisible] = useState(false);
  const timeoutRef = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const tooltipId = useRef(`tooltip-${Math.random().toString(36).substring(2, 9)}`);

  const showTooltip = () => {
    if (disabled || !content) return;
    clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      setIsVisible(true);
    }, delay);
  };

  const hideTooltip = () => {
    clearTimeout(timeoutRef.current);
    setIsVisible(false);
  };

  useEffect(() => {
    return () => {
      clearTimeout(timeoutRef.current);
    };
  }, []);

  // Compute position classes based on side and align
  const getPositionClasses = () => {
    switch (side) {
      case "bottom":
        return "top-full mt-2 " + (align === "start" ? "left-0" : align === "end" ? "right-0" : "left-1/2 -translate-x-1/2");
      case "left":
        return "right-full mr-2 " + (align === "start" ? "top-0" : align === "end" ? "bottom-0" : "top-1/2 -translate-y-1/2");
      case "right":
        return "left-full ml-2 " + (align === "start" ? "top-0" : align === "end" ? "bottom-0" : "top-1/2 -translate-y-1/2");
      case "top":
      default:
        return "bottom-full mb-2 " + (align === "start" ? "left-0" : align === "end" ? "right-0" : "left-1/2 -translate-x-1/2");
    }
  };

  return (
    <div
      ref={containerRef}
      className={`relative inline-flex items-center ${className}`}
      onMouseEnter={showTooltip}
      onMouseLeave={hideTooltip}
      onFocus={showTooltip}
      onBlur={hideTooltip}
      aria-describedby={isVisible ? tooltipId.current : undefined}
    >
      {children}

      <AnimatePresence>
        {isVisible && !disabled && content && (
          <motion.div
            id={tooltipId.current}
            role="tooltip"
            initial={{ opacity: 0, scale: 0.92, y: side === "top" ? 4 : side === "bottom" ? -4 : 0 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.92, y: side === "top" ? 2 : side === "bottom" ? -2 : 0 }}
            transition={{ duration: 0.15, ease: "easeOut" }}
            className={`absolute z-50 pointer-events-none whitespace-nowrap px-2.5 py-1.5 rounded-lg border border-white/15 bg-slate-950/95 backdrop-blur-xl text-slate-100 text-xs shadow-2xl shadow-black/80 font-sans tracking-normal ${getPositionClasses()}`}
          >
            <div className="flex items-center gap-2">
              <span className="font-medium text-slate-200">{content}</span>
              {badge && (
                <span className="px-1.5 py-0.2 rounded bg-cyan-500/20 text-cyan-300 text-[10px] font-mono border border-cyan-500/30 uppercase">
                  {badge}
                </span>
              )}
              {shortcut && (
                <kbd className="px-1.5 py-0.5 rounded bg-white/10 text-slate-400 text-[10px] font-mono border border-white/10">
                  {shortcut}
                </kbd>
              )}
            </div>
            {/* Subtle arrow pointer */}
            <div
              className={`absolute w-1.5 h-1.5 bg-slate-950 border-white/15 transform rotate-45 pointer-events-none ${
                side === "bottom"
                  ? "-top-1 left-1/2 -translate-x-1/2 border-t border-l"
                  : side === "left"
                  ? "-right-1 top-1/2 -translate-y-1/2 border-t border-r"
                  : side === "right"
                  ? "-left-1 top-1/2 -translate-y-1/2 border-b border-l"
                  : "-bottom-1 left-1/2 -translate-x-1/2 border-b border-r"
              }`}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
