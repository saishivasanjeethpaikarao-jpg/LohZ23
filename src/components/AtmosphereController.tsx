import React, { useState } from "react";
import { 
  Volume2, 
  VolumeX, 
  Music, 
  Sparkles, 
  Sliders, 
  X, 
  Radio, 
  Headphones,
  Disc,
  CloudRain,
  Waves
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { AtmosphereEngine, ATMOSPHERE_PRESETS, SoundscapePreset } from "../lib/atmosphere";
import { Tooltip } from "./Tooltip";

interface AtmosphereControllerProps {
  engine: AtmosphereEngine | null;
  isPlaying: boolean;
  onToggle: () => void;
  themeColor: string;
  onThemeSelect?: (color: string) => void;
}

export const AtmosphereController: React.FC<AtmosphereControllerProps> = ({
  engine,
  isPlaying,
  onToggle,
  themeColor,
  onThemeSelect
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [volume, setVolume] = useState<number>(engine ? engine.getVolume() : 0.45);
  const [textureMode, setTextureMode] = useState<"all" | "chords" | "drone" | "tape">(
    (engine?.getTextureMode() as any) || "all"
  );

  const activePreset = ATMOSPHERE_PRESETS[themeColor] || ATMOSPHERE_PRESETS.charcoal;

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    setVolume(val);
    if (engine) {
      engine.setVolume(val);
    }
  };

  const handleTextureChange = (mode: "all" | "chords" | "drone" | "tape") => {
    setTextureMode(mode);
    if (engine) {
      engine.setTextureMode(mode);
    }
  };

  const textureOptions: { id: "all" | "chords" | "drone" | "tape"; label: string; icon: any; desc: string }[] = [
    { id: "all", label: "Full Harmony", icon: Waves, desc: "Lofi chords, drone, and tape warmth" },
    { id: "chords", label: "Melodic Swells", icon: Music, desc: "Gentle procedural chord progressions" },
    { id: "drone", label: "Meditative Drone", icon: Radio, desc: "Deep continuous resonant frequencies" },
    { id: "tape", label: "Tape Hiss & Vinyl", icon: Disc, desc: "Warm organic texture & gentle crackle" },
  ];

  return (
    <>
      {/* Header Quick Trigger with Animated Visualizer */}
      <div className="flex items-center gap-1.5">
        <Tooltip content={isPlaying ? "Atmosphere Playing: Click to adjust soundscape" : "Start Atmosphere Lo-Fi Soundscape"} side="bottom">
          <button
            onClick={isPlaying ? () => setIsOpen(!isOpen) : onToggle}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-xl transition text-xs font-mono tracking-wider cursor-pointer border ${
              isPlaying
                ? "bg-purple-950/40 border-purple-500/30 text-purple-300 shadow-[0_0_15px_rgba(168,85,247,0.2)]"
                : "opacity-40 hover:opacity-100 border-white/10 hover:border-white/20 text-white bg-white/5"
            }`}
            aria-label="Toggle Atmosphere Soundscape"
          >
            <Headphones size={13} className={isPlaying ? "text-purple-400 animate-pulse" : "text-slate-400"} />
            <span className="hidden md:inline">{isPlaying ? activePreset.name.toUpperCase() : "ATMOSPHERE"}</span>

            {/* Subtle animated mini-waveform indicator when playing */}
            {isPlaying && (
              <div className="flex items-center gap-0.5 ml-1 h-3">
                {[4, 10, 6, 12, 5].map((h, i) => (
                  <span
                    key={i}
                    className="w-0.5 bg-purple-400 rounded-full animate-pulse"
                    style={{
                      height: `${h}px`,
                      animationDelay: `${i * 0.15}s`,
                      animationDuration: "1.2s"
                    }}
                  />
                ))}
              </div>
            )}
          </button>
        </Tooltip>

        {isPlaying && (
          <Tooltip content="Atmosphere Controls & Settings" side="bottom">
            <button
              onClick={() => setIsOpen(!isOpen)}
              className="p-1 rounded-lg border border-white/10 bg-white/5 text-slate-400 hover:text-white hover:bg-white/10 transition cursor-pointer"
              aria-label="Atmosphere Settings"
            >
              <Sliders size={12} />
            </button>
          </Tooltip>
        )}
      </div>

      {/* Floating Detailed Atmosphere Control Center Drawer / Popover */}
      <AnimatePresence>
        {isOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/60 backdrop-blur-md">
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 15 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 15 }}
              className="relative w-full max-w-md p-6 rounded-3xl border border-purple-500/20 bg-slate-950/90 backdrop-blur-2xl shadow-[0_0_50px_rgba(147,51,234,0.15)] text-left"
            >
              {/* Header */}
              <div className="flex items-center justify-between pb-4 border-b border-white/10 mb-4">
                <div className="flex items-center gap-3">
                  <div className="p-2.5 rounded-2xl bg-purple-500/20 text-purple-300 border border-purple-500/30">
                    <Headphones size={18} />
                  </div>
                  <div>
                    <h3 className="font-mono text-xs uppercase tracking-widest text-purple-300 font-bold">
                      Atmosphere Ambient Soundscape
                    </h3>
                    <p className="text-sm font-semibold text-white mt-0.5 flex items-center gap-1.5">
                      <span>{activePreset.name}</span>
                      <span className="text-xs text-purple-400 font-normal font-mono">({activePreset.mood})</span>
                    </p>
                  </div>
                </div>

                <Tooltip content="Close Settings" side="left">
                  <button
                    onClick={() => setIsOpen(false)}
                    className="p-1.5 rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 text-slate-400 hover:text-white transition cursor-pointer"
                  >
                    <X size={16} />
                  </button>
                </Tooltip>
              </div>

              {/* Master Playback Toggle Card */}
              <div className="p-4 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-between mb-4">
                <div>
                  <h4 className="text-xs font-mono font-bold text-slate-200 uppercase tracking-wide">
                    Soundscape Engine
                  </h4>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Context-aware procedural audio reactive to theme palette
                  </p>
                </div>
                <button
                  onClick={onToggle}
                  className={`px-4 py-2 rounded-xl text-xs font-mono font-bold tracking-wider transition cursor-pointer flex items-center gap-2 ${
                    isPlaying
                      ? "bg-purple-600 hover:bg-purple-500 text-white shadow-[0_0_20px_rgba(147,51,234,0.4)]"
                      : "bg-white/10 hover:bg-white/20 text-slate-300"
                  }`}
                >
                  {isPlaying ? (
                    <>
                      <Volume2 size={14} />
                      <span>ACTIVE</span>
                    </>
                  ) : (
                    <>
                      <VolumeX size={14} />
                      <span>MUTED</span>
                    </>
                  )}
                </button>
              </div>

              {/* Volume Slider Control */}
              <div className="p-4 rounded-2xl bg-white/5 border border-white/10 mb-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-mono text-slate-300 font-bold uppercase flex items-center gap-1.5">
                    <Volume2 size={13} className="text-purple-400" />
                    <span>Atmosphere Volume</span>
                  </span>
                  <span className="text-xs font-mono text-purple-300 font-bold">
                    {Math.round(volume * 100)}%
                  </span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={volume}
                  onChange={handleVolumeChange}
                  className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-purple-500"
                />
              </div>

              {/* Texture Mode Selector */}
              <div className="mb-4">
                <label className="block text-[11px] font-mono font-bold uppercase text-slate-400 mb-2">
                  Soundscape Texture Layer
                </label>
                <div className="grid grid-cols-2 gap-2">
                  {textureOptions.map((opt) => {
                    const Icon = opt.icon;
                    const isSelected = textureMode === opt.id;
                    return (
                      <Tooltip key={opt.id} content={opt.desc} side="top">
                        <button
                          onClick={() => handleTextureChange(opt.id)}
                          className={`w-full p-2.5 rounded-xl border text-left transition cursor-pointer flex flex-col gap-1 ${
                            isSelected
                              ? "bg-purple-950/60 border-purple-500/50 text-white shadow-md shadow-purple-950/50"
                              : "bg-white/5 border-white/5 text-slate-400 hover:text-slate-200 hover:bg-white/10"
                          }`}
                        >
                          <div className="flex items-center gap-1.5 text-xs font-mono font-semibold">
                            <Icon size={13} className={isSelected ? "text-purple-400" : "text-slate-500"} />
                            <span className={isSelected ? "text-purple-200" : ""}>{opt.label}</span>
                          </div>
                        </button>
                      </Tooltip>
                    );
                  })}
                </div>
              </div>

              {/* Theme / Palette Atmosphere Selector */}
              <div>
                <label className="block text-[11px] font-mono font-bold uppercase text-slate-400 mb-2">
                  Harmonic Atmosphere Theme Presets
                </label>
                <div className="grid grid-cols-3 sm:grid-cols-4 gap-1.5">
                  {Object.entries(ATMOSPHERE_PRESETS).map(([key, preset]) => {
                    const isCurrent = themeColor === key;
                    return (
                      <Tooltip key={key} content={`${preset.name} - ${preset.mood}`} side="bottom">
                        <button
                          onClick={() => {
                            if (onThemeSelect) onThemeSelect(key);
                            if (engine) engine.setTheme(key);
                          }}
                          className={`w-full p-2 rounded-xl border text-left transition cursor-pointer flex items-center justify-between text-[11px] font-mono ${
                            isCurrent
                              ? "bg-purple-500/20 border-purple-400 text-purple-200 font-bold"
                              : "bg-white/5 border-white/5 text-slate-400 hover:text-white hover:bg-white/10"
                          }`}
                        >
                          <span className="capitalize truncate">{key}</span>
                          <span className={`w-2 h-2 rounded-full ${
                            key === "violet" ? "bg-purple-400" :
                            key === "crimson" ? "bg-rose-400" :
                            key === "emerald" ? "bg-emerald-400" :
                            key === "celestial" ? "bg-sky-400" :
                            key === "gold" ? "bg-amber-400" :
                            key === "rose" ? "bg-pink-400" : "bg-slate-400"
                          }`} />
                        </button>
                      </Tooltip>
                    );
                  })}
                </div>
              </div>

              {/* Footer info note */}
              <div className="mt-5 pt-3 border-t border-white/10 flex items-center justify-between text-[10px] font-mono text-slate-500">
                <span className="flex items-center gap-1">
                  <Sparkles size={11} className="text-purple-400" />
                  Procedural Web Audio Synthesizer
                </span>
                <span>Zero Latency • Continuous</span>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </>
  );
};
