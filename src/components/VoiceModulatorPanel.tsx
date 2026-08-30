import React, { useState, useEffect } from "react";
import { motion } from "motion/react";
import { Sliders, Volume2, Mic, RotateCcw, Sparkles, X, ChevronRight } from "lucide-react";
import { Tooltip } from "./Tooltip";

interface VoiceModulatorPanelProps {
  isOpen: boolean;
  onClose: () => void;
  onSpeedChange: (speed: number) => void;
  onPitchChange: (cents: number) => void;
  initialSpeed?: number;
  initialPitchCents?: number;
}

export const VoiceModulatorPanel: React.FC<VoiceModulatorPanelProps> = ({
  isOpen,
  onClose,
  onSpeedChange,
  onPitchChange,
  initialSpeed = 1.0,
  initialPitchCents = 0,
}) => {
  const [speed, setSpeed] = useState<number>(initialSpeed);
  const [pitchCents, setPitchCents] = useState<number>(initialPitchCents);

  // Load saved preferences from localStorage
  useEffect(() => {
    const savedSpeed = localStorage.getItem("lohz_voice_speed");
    const savedPitch = localStorage.getItem("lohz_voice_pitch");
    if (savedSpeed) {
      const parsed = parseFloat(savedSpeed);
      if (!isNaN(parsed)) {
        setSpeed(parsed);
        onSpeedChange(parsed);
      }
    }
    if (savedPitch) {
      const parsed = parseInt(savedPitch, 10);
      if (!isNaN(parsed)) {
        setPitchCents(parsed);
        onPitchChange(parsed);
      }
    }
  }, []);

  const handleSpeedChange = (val: number) => {
    setSpeed(val);
    localStorage.setItem("lohz_voice_speed", val.toString());
    onSpeedChange(val);
  };

  const handlePitchChange = (val: number) => {
    setPitchCents(val);
    localStorage.setItem("lohz_voice_pitch", val.toString());
    onPitchChange(val);
  };

  const applyPreset = (newSpeed: number, newPitch: number) => {
    handleSpeedChange(newSpeed);
    handlePitchChange(newPitch);
  };

  const handleReset = () => {
    applyPreset(1.0, 0);
  };

  if (!isOpen) return null;

  // Convert cents to semitones for friendly display
  const semitones = (pitchCents / 100).toFixed(1);

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.92, y: 15 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.92, y: 15 }}
      transition={{ duration: 0.2, ease: "easeOut" }}
      className="fixed bottom-24 right-4 sm:right-8 z-50 w-[92vw] sm:w-84 p-5 rounded-3xl bg-[#080914]/90 border border-cyan-500/30 backdrop-blur-2xl shadow-[0_0_50px_rgba(34,211,238,0.25)] text-white select-none"
    >
      {/* Header */}
      <div className="flex items-center justify-between pb-3 mb-4 border-b border-white/10">
        <div className="flex items-center gap-2">
          <div className="p-1.5 rounded-xl bg-cyan-500/20 border border-cyan-400/40 text-cyan-300">
            <Sliders size={16} />
          </div>
          <div>
            <h3 className="text-xs font-mono font-bold tracking-widest uppercase text-cyan-200 flex items-center gap-1.5">
              VOICE MODULATOR <span className="text-[9px] px-1.5 py-0.2 rounded bg-cyan-400/10 text-cyan-300">LIVE</span>
            </h3>
            <p className="text-[10px] text-slate-400 font-sans">Tune LOHZ vocal pitch & tempo in real time</p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Tooltip content="Reset to default voice settings" side="top">
            <button
              onClick={handleReset}
              className="p-1.5 rounded-xl text-slate-400 hover:text-white hover:bg-white/10 transition cursor-pointer"
              aria-label="Reset Voice Settings"
            >
              <RotateCcw size={14} />
            </button>
          </Tooltip>
          <button
            onClick={onClose}
            className="p-1.5 rounded-xl text-slate-400 hover:text-white hover:bg-white/10 transition cursor-pointer"
            aria-label="Close Voice Modulator"
          >
            <X size={16} />
          </button>
        </div>
      </div>

      {/* Preset Badges */}
      <div className="mb-4">
        <span className="text-[10px] font-mono uppercase tracking-wider text-slate-400 block mb-2">
          Quick Vocal Archetypes
        </span>
        <div className="grid grid-cols-2 gap-1.5">
          <button
            onClick={() => applyPreset(1.0, 0)}
            className={`px-2.5 py-1.5 rounded-xl text-[11px] font-mono transition text-left cursor-pointer border ${
              speed === 1.0 && pitchCents === 0
                ? "bg-cyan-500/20 border-cyan-400 text-cyan-200"
                : "bg-white/5 border-white/5 text-slate-300 hover:bg-white/10"
            }`}
          >
            ✨ Default Anime
          </button>
          <button
            onClick={() => applyPreset(0.95, 200)}
            className={`px-2.5 py-1.5 rounded-xl text-[11px] font-mono transition text-left cursor-pointer border ${
              speed === 0.95 && pitchCents === 200
                ? "bg-purple-500/20 border-purple-400 text-purple-200"
                : "bg-white/5 border-white/5 text-slate-300 hover:bg-white/10"
            }`}
          >
            🌸 Sweet Heroine (+2st)
          </button>
          <button
            onClick={() => applyPreset(1.15, 350)}
            className={`px-2.5 py-1.5 rounded-xl text-[11px] font-mono transition text-left cursor-pointer border ${
              speed === 1.15 && pitchCents === 350
                ? "bg-pink-500/20 border-pink-400 text-pink-200"
                : "bg-white/5 border-white/5 text-slate-300 hover:bg-white/10"
            }`}
          >
            🎀 Chibi Playful (+3.5st)
          </button>
          <button
            onClick={() => applyPreset(0.88, -150)}
            className={`px-2.5 py-1.5 rounded-xl text-[11px] font-mono transition text-left cursor-pointer border ${
              speed === 0.88 && pitchCents === -150
                ? "bg-amber-500/20 border-amber-400 text-amber-200"
                : "bg-white/5 border-white/5 text-slate-300 hover:bg-white/10"
            }`}
          >
            🌙 Cozy Late-Night (-1.5st)
          </button>
        </div>
      </div>

      {/* Speed Slider */}
      <div className="mb-4">
        <div className="flex items-center justify-between text-xs font-mono mb-1.5">
          <span className="text-slate-300 flex items-center gap-1.5">
            <Volume2 size={13} className="text-cyan-400" />
            Speech Speed (Tempo)
          </span>
          <span className="text-cyan-300 font-bold">{speed.toFixed(2)}x</span>
        </div>
        <input
          type="range"
          min="0.75"
          max="1.35"
          step="0.05"
          value={speed}
          onChange={(e) => handleSpeedChange(parseFloat(e.target.value))}
          className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-cyan-400"
        />
        <div className="flex justify-between text-[9px] font-mono text-slate-500 mt-1">
          <span>0.75x (Calm/Delicate)</span>
          <span>1.0x (Standard)</span>
          <span>1.35x (Brisk)</span>
        </div>
      </div>

      {/* Pitch Slider */}
      <div className="mb-4">
        <div className="flex items-center justify-between text-xs font-mono mb-1.5">
          <span className="text-slate-300 flex items-center gap-1.5">
            <Sparkles size={13} className="text-fuchsia-400" />
            Vocal Pitch Tuning
          </span>
          <span className="text-fuchsia-300 font-bold">
            {pitchCents > 0 ? `+${semitones}` : semitones} st ({pitchCents > 0 ? `+${pitchCents}` : pitchCents}¢)
          </span>
        </div>
        <input
          type="range"
          min="-600"
          max="600"
          step="50"
          value={pitchCents}
          onChange={(e) => handlePitchChange(parseInt(e.target.value, 10))}
          className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-fuchsia-400"
        />
        <div className="flex justify-between text-[9px] font-mono text-slate-500 mt-1">
          <span>-6.0st (Deeper)</span>
          <span>0st (Natural)</span>
          <span>+6.0st (Higher)</span>
        </div>
      </div>

      {/* Real-time sync feedback footer */}
      <div className="pt-2.5 border-t border-white/5 flex items-center justify-between text-[10px] font-mono text-slate-400">
        <span className="flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
          Active Live DSP Resampler
        </span>
        <span className="text-cyan-400/80">Web Audio API</span>
      </div>
    </motion.div>
  );
};
