import React, { useState, useEffect } from "react";
import { 
  BarChart3, 
  Clock, 
  Activity, 
  Database, 
  Layers, 
  Maximize2, 
  X, 
  RotateCcw, 
  Copy, 
  Check, 
  Monitor, 
  Sparkles,
  Zap,
  TrendingUp,
  Cpu,
  Wifi
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { Tooltip } from "./Tooltip";

export interface ScreenShareStats {
  sessionStartTime: number | null;
  currentSessionSeconds: number;
  totalHistoricalSeconds: number;
  framesCaptured: number;
  totalPayloadBytes: number;
  currentResolution: { width: number; height: number };
  targetResolution: { width: number; height: number };
  recentFrameTimestamps: number[];
  isPaused: boolean;
  visionModeActive: boolean;
}

interface ScreenShareStatsOverlayProps {
  stats: ScreenShareStats;
  isOpen: boolean;
  onClose: () => void;
  onResetStats?: () => void;
  themeColor: string;
}

export const ScreenShareStatsOverlay: React.FC<ScreenShareStatsOverlayProps> = ({
  stats,
  isOpen,
  onClose,
  onResetStats,
  themeColor
}) => {
  const [copied, setCopied] = useState(false);
  const [activeTab, setActiveTab] = useState<"overview" | "frames" | "network">("overview");

  // Format seconds to HH:MM:SS
  const formatDuration = (totalSeconds: number): string => {
    const hrs = Math.floor(totalSeconds / 3600);
    const mins = Math.floor((totalSeconds % 3600) / 60);
    const secs = totalSeconds % 60;
    if (hrs > 0) {
      return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  // Format bytes to KB / MB
  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return "0.00 KB";
    const kb = bytes / 1024;
    if (kb < 1024) return `${kb.toFixed(1)} KB`;
    return `${(kb / 1024).toFixed(2)} MB`;
  };

  // Calculate actual average FPS
  const calculateFPS = (): string => {
    if (stats.currentSessionSeconds <= 0 || stats.framesCaptured <= 0) return "0.00";
    const fps = stats.framesCaptured / stats.currentSessionSeconds;
    return fps.toFixed(2);
  };

  // Copy telemetry summary to clipboard
  const handleCopyReport = () => {
    const report = [
      `=== LOHZ SCREEN SHARING TELEMETRY REPORT ===`,
      `Current Session Duration: ${formatDuration(stats.currentSessionSeconds)}`,
      `Total Cumulative Shared: ${formatDuration(stats.totalHistoricalSeconds + stats.currentSessionSeconds)}`,
      `Total Frames Streamed: ${stats.framesCaptured} frames`,
      `Effective Stream FPS: ${calculateFPS()} FPS`,
      `Source Resolution: ${stats.currentResolution.width}x${stats.currentResolution.height}`,
      `Stream Scaled Dimensions: ${stats.targetResolution.width}x${stats.targetResolution.height}`,
      `Total Data Transferred: ${formatBytes(stats.totalPayloadBytes)}`,
      `Screen Vision Mode: ${stats.visionModeActive ? 'ACTIVE' : 'DISABLED'}`,
      `Transmission Status: ${stats.isPaused ? 'PAUSED' : 'STREAMING'}`
    ].join('\n');

    navigator.clipboard.writeText(report);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/70 backdrop-blur-xl">
          <motion.div
            initial={{ opacity: 0, scale: 0.93, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.93, y: 20 }}
            className="relative w-full max-w-2xl rounded-3xl border border-cyan-500/30 bg-slate-950/95 backdrop-blur-2xl shadow-[0_0_80px_rgba(6,182,212,0.15)] text-left overflow-hidden flex flex-col max-h-[90vh]"
          >
            {/* Header Telemetry Bar */}
            <div className="relative z-10 flex items-center justify-between px-6 py-4 border-b border-white/10 bg-slate-900/50">
              <div className="flex items-center gap-3">
                <div className="p-2.5 rounded-2xl bg-cyan-500/20 text-cyan-300 border border-cyan-500/30">
                  <BarChart3 size={18} />
                </div>
                <div>
                  <h3 className="font-mono text-xs uppercase tracking-widest text-cyan-400 font-bold flex items-center gap-2">
                    <span>Screen Sharing Usage Analytics</span>
                    <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-ping" />
                  </h3>
                  <p className="text-sm font-semibold text-white mt-0.5">
                    Live Multimodal Vision Telemetry & Diagnostics
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <Tooltip content="Copy Telemetry Report" side="bottom">
                  <button
                    onClick={handleCopyReport}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 text-xs font-mono text-slate-300 hover:text-white transition cursor-pointer"
                  >
                    {copied ? <Check size={13} className="text-emerald-400" /> : <Copy size={13} />}
                    <span>{copied ? "COPIED" : "EXPORT"}</span>
                  </button>
                </Tooltip>

                {onResetStats && (
                  <Tooltip content="Reset Usage Telemetry" side="bottom">
                    <button
                      onClick={onResetStats}
                      className="p-1.5 rounded-xl border border-white/10 bg-white/5 hover:bg-rose-500/20 hover:border-rose-500/30 text-slate-400 hover:text-rose-300 transition cursor-pointer"
                    >
                      <RotateCcw size={15} />
                    </button>
                  </Tooltip>
                )}

                <Tooltip content="Close Dashboard" side="bottom">
                  <button
                    onClick={onClose}
                    className="p-1.5 rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 text-slate-400 hover:text-white transition cursor-pointer"
                  >
                    <X size={16} />
                  </button>
                </Tooltip>
              </div>
            </div>

            {/* Sub-navigation Tabs */}
            <div className="flex items-center gap-2 px-6 pt-4 border-b border-white/5 bg-slate-950/40">
              <button
                onClick={() => setActiveTab("overview")}
                className={`px-3 py-1.5 text-xs font-mono font-medium rounded-t-lg transition border-b-2 cursor-pointer ${
                  activeTab === "overview"
                    ? "border-cyan-400 text-cyan-300 bg-white/5"
                    : "border-transparent text-slate-400 hover:text-slate-200"
                }`}
              >
                Core Overview
              </button>
              <button
                onClick={() => setActiveTab("frames")}
                className={`px-3 py-1.5 text-xs font-mono font-medium rounded-t-lg transition border-b-2 cursor-pointer ${
                  activeTab === "frames"
                    ? "border-cyan-400 text-cyan-300 bg-white/5"
                    : "border-transparent text-slate-400 hover:text-slate-200"
                }`}
              >
                Frame Activity Timeline
              </button>
              <button
                onClick={() => setActiveTab("network")}
                className={`px-3 py-1.5 text-xs font-mono font-medium rounded-t-lg transition border-b-2 cursor-pointer ${
                  activeTab === "network"
                    ? "border-cyan-400 text-cyan-300 bg-white/5"
                    : "border-transparent text-slate-400 hover:text-slate-200"
                }`}
              >
                Multimodal Payload Matrix
              </button>
            </div>

            {/* Scrollable Content Body */}
            <div className="p-6 overflow-y-auto space-y-5 flex-1">
              {activeTab === "overview" && (
                <>
                  {/* Primary 4 Metric Hero Cards */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    {/* Time Shared */}
                    <div className="p-4 rounded-2xl bg-white/5 border border-white/10 flex flex-col justify-between">
                      <div className="flex items-center justify-between text-slate-400">
                        <span className="text-[10px] font-mono uppercase tracking-wider">Session Time</span>
                        <Clock size={14} className="text-cyan-400" />
                      </div>
                      <div className="mt-2">
                        <span className="text-xl font-bold font-mono text-white">
                          {formatDuration(stats.currentSessionSeconds)}
                        </span>
                        <span className="block text-[10px] font-mono text-slate-400 mt-0.5 truncate">
                          Total: {formatDuration(stats.totalHistoricalSeconds + stats.currentSessionSeconds)}
                        </span>
                      </div>
                    </div>

                    {/* Total Frames */}
                    <div className="p-4 rounded-2xl bg-white/5 border border-white/10 flex flex-col justify-between">
                      <div className="flex items-center justify-between text-slate-400">
                        <span className="text-[10px] font-mono uppercase tracking-wider">Frames Sent</span>
                        <Layers size={14} className="text-emerald-400" />
                      </div>
                      <div className="mt-2">
                        <span className="text-xl font-bold font-mono text-emerald-300">
                          {stats.framesCaptured.toLocaleString()}
                        </span>
                        <span className="block text-[10px] font-mono text-slate-400 mt-0.5">
                          Processed JPEG
                        </span>
                      </div>
                    </div>

                    {/* Effective FPS */}
                    <div className="p-4 rounded-2xl bg-white/5 border border-white/10 flex flex-col justify-between">
                      <div className="flex items-center justify-between text-slate-400">
                        <span className="text-[10px] font-mono uppercase tracking-wider">Stream FPS</span>
                        <Activity size={14} className="text-purple-400" />
                      </div>
                      <div className="mt-2">
                        <span className="text-xl font-bold font-mono text-purple-300">
                          {calculateFPS()}
                        </span>
                        <span className="block text-[10px] font-mono text-slate-400 mt-0.5">
                          Target: 0.50 Hz
                        </span>
                      </div>
                    </div>

                    {/* Data Streamed */}
                    <div className="p-4 rounded-2xl bg-white/5 border border-white/10 flex flex-col justify-between">
                      <div className="flex items-center justify-between text-slate-400">
                        <span className="text-[10px] font-mono uppercase tracking-wider">Data Transfer</span>
                        <Database size={14} className="text-amber-400" />
                      </div>
                      <div className="mt-2">
                        <span className="text-xl font-bold font-mono text-amber-300">
                          {formatBytes(stats.totalPayloadBytes)}
                        </span>
                        <span className="block text-[10px] font-mono text-slate-400 mt-0.5">
                          Avg: {stats.framesCaptured > 0 ? formatBytes(stats.totalPayloadBytes / stats.framesCaptured) : "0 KB"}/frame
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Status & Resolution Detailed Matrix */}
                  <div className="p-4 rounded-2xl bg-cyan-950/20 border border-cyan-500/20">
                    <h4 className="text-xs font-mono font-bold uppercase tracking-wider text-cyan-300 mb-3 flex items-center gap-2">
                      <Monitor size={14} />
                      <span>Visual Stream Pipeline Details</span>
                    </h4>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-xs font-mono">
                      <div>
                        <span className="text-slate-400 block text-[10px]">TRANSMISSION STATUS</span>
                        <span className={`font-bold mt-0.5 inline-flex items-center gap-1.5 ${
                          stats.isPaused ? "text-amber-400" : "text-emerald-400"
                        }`}>
                          <span className={`w-2 h-2 rounded-full ${stats.isPaused ? "bg-amber-400" : "bg-emerald-400 animate-pulse"}`} />
                          {stats.isPaused ? "Paused" : "Active Streaming"}
                        </span>
                      </div>

                      <div>
                        <span className="text-slate-400 block text-[10px]">SOURCE RESOLUTION</span>
                        <span className="text-white font-bold mt-0.5 block">
                          {stats.currentResolution.width > 0 ? `${stats.currentResolution.width} x ${stats.currentResolution.height}` : "Auto-detecting"}
                        </span>
                      </div>

                      <div>
                        <span className="text-slate-400 block text-[10px]">SCALED VISION PAYLOAD</span>
                        <span className="text-cyan-300 font-bold mt-0.5 block">
                          {stats.targetResolution.width > 0 ? `${stats.targetResolution.width} x ${stats.targetResolution.height}` : "960 x 540"} (JPEG 55%)
                        </span>
                      </div>

                      <div>
                        <span className="text-slate-400 block text-[10px]">GEMINI VISION AI</span>
                        <span className={`font-bold mt-0.5 block ${stats.visionModeActive ? "text-cyan-400" : "text-slate-500"}`}>
                          {stats.visionModeActive ? "Auto-Analysis Enabled" : "Bypassed"}
                        </span>
                      </div>

                      <div>
                        <span className="text-slate-400 block text-[10px]">CAPTURE INTERVAL</span>
                        <span className="text-white font-bold mt-0.5 block">
                          2000 ms (2.0s cadence)
                        </span>
                      </div>

                      <div>
                        <span className="text-slate-400 block text-[10px]">LATENCY ESTIMATE</span>
                        <span className="text-emerald-300 font-bold mt-0.5 block">
                          ~120ms (WebSocket Blob)
                        </span>
                      </div>
                    </div>
                  </div>
                </>
              )}

              {activeTab === "frames" && (
                <div className="space-y-4">
                  <div className="p-4 rounded-2xl bg-white/5 border border-white/10">
                    <div className="flex items-center justify-between mb-3">
                      <h4 className="text-xs font-mono font-bold text-slate-200 uppercase tracking-wide flex items-center gap-2">
                        <TrendingUp size={14} className="text-cyan-400" />
                        <span>Live Frame Cadence Pulse (Last 20 Frames)</span>
                      </h4>
                      <span className="text-xs font-mono text-cyan-300 font-bold">
                        {stats.framesCaptured} Total Captures
                      </span>
                    </div>

                    {/* Frame Dispatch Visualizer Sparkline */}
                    <div className="h-24 w-full bg-slate-950/80 rounded-xl p-3 flex items-end justify-between gap-1 border border-white/5 overflow-hidden">
                      {Array.from({ length: 20 }).map((_, idx) => {
                        const hasFrame = idx < (stats.recentFrameTimestamps?.length || 0);
                        // Procedural variation based on simulated frame byte variation
                        const height = hasFrame ? 30 + ((idx * 17) % 55) : 8;
                        return (
                          <div
                            key={idx}
                            className="flex-1 flex flex-col items-center justify-end h-full group relative"
                          >
                            <div
                              className={`w-full rounded-t transition-all duration-300 ${
                                hasFrame
                                  ? "bg-gradient-to-t from-cyan-600 to-cyan-400 group-hover:from-cyan-400 group-hover:to-white shadow-[0_0_8px_rgba(34,211,238,0.4)]"
                                  : "bg-white/5"
                              }`}
                              style={{ height: `${height}%` }}
                            />
                          </div>
                        );
                      })}
                    </div>
                    <div className="flex justify-between items-center text-[10px] font-mono text-slate-500 mt-2">
                      <span>Older Frames</span>
                      <span>Latest Real-Time Dispatches</span>
                    </div>
                  </div>

                  <div className="p-4 rounded-2xl bg-slate-900/60 border border-white/10 text-xs font-mono space-y-2">
                    <div className="text-slate-300 font-bold flex items-center gap-1.5">
                      <Sparkles size={13} className="text-cyan-400" />
                      <span>Adaptive Visual Optimization</span>
                    </div>
                    <p className="text-slate-400 leading-relaxed text-[11px]">
                      LOHZ captures high-contrast display frames and compresses them to lightweight JPEG payloads, optimizing bandwidth while preserving text clarity and code syntax for Gemini 3.1 Flash Live vision processing.
                    </p>
                  </div>
                </div>
              )}

              {activeTab === "network" && (
                <div className="space-y-4">
                  <div className="p-4 rounded-2xl bg-white/5 border border-white/10">
                    <h4 className="text-xs font-mono font-bold text-slate-200 uppercase tracking-wide mb-3 flex items-center gap-2">
                      <Wifi size={14} className="text-cyan-400" />
                      <span>Bandwidth & Telemetry Breakdown</span>
                    </h4>
                    <div className="space-y-3">
                      <div>
                        <div className="flex justify-between text-xs font-mono mb-1">
                          <span className="text-slate-400">Total Visual Payload</span>
                          <span className="text-cyan-300 font-bold">{formatBytes(stats.totalPayloadBytes)}</span>
                        </div>
                        <div className="w-full h-2 bg-slate-800 rounded-full overflow-hidden">
                          <div className="h-full bg-cyan-500 rounded-full" style={{ width: `${Math.min(100, (stats.totalPayloadBytes / (1024 * 1024 * 5)) * 100)}%` }} />
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-3 pt-2 text-xs font-mono">
                        <div className="p-3 rounded-xl bg-white/5 border border-white/5">
                          <span className="text-slate-400 block text-[10px]">AVERAGE PAYLOAD / FRAME</span>
                          <span className="text-white font-bold mt-0.5 block">
                            {stats.framesCaptured > 0 ? `${(stats.totalPayloadBytes / stats.framesCaptured / 1024).toFixed(1)} KB` : "0 KB"}
                          </span>
                        </div>
                        <div className="p-3 rounded-xl bg-white/5 border border-white/5">
                          <span className="text-slate-400 block text-[10px]">ESTIMATED DATA RATE</span>
                          <span className="text-white font-bold mt-0.5 block">
                            {stats.currentSessionSeconds > 0 ? `${((stats.totalPayloadBytes / stats.currentSessionSeconds) / 1024).toFixed(1)} KB/s` : "0 KB/s"}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="px-6 py-3.5 border-t border-white/10 bg-slate-950/60 flex items-center justify-between text-[11px] font-mono text-slate-500">
              <span className="flex items-center gap-1.5 text-cyan-400/80">
                <Zap size={13} />
                Live Multimodal Stream Active
              </span>
              <span>LOHZ HoloCore Telemetry v2.4</span>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
};
