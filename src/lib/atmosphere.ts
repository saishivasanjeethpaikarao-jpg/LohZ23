/**
 * Atmosphere Engine: Procedural Web Audio Ambient Soundscapes & Lo-Fi Generator.
 * Generates context-aware background music and ambient soundscapes dynamically
 * based on the active theme color with zero external asset dependencies.
 */

export interface SoundscapePreset {
  id: string;
  name: string;
  themeColor: string;
  mood: string;
  baseFreqs: number[]; // Fundamental chord frequencies (Hz)
  droneFreq: number;
  filterCutoff: number;
  resonance: number;
  chords: number[][]; // Multi-chord progression sets
  noiseColor: "pink" | "brown" | "white";
  noiseGain: number;
  tempo: number; // Seconds per chord transition
}

export const ATMOSPHERE_PRESETS: Record<string, SoundscapePreset> = {
  violet: {
    id: "violet",
    name: "Cosmic Twilight",
    themeColor: "violet",
    mood: "Ethereal Dreamscape",
    baseFreqs: [146.83, 174.61, 220.0, 261.63], // D3, F3, A3, C4 (Dm7)
    droneFreq: 73.42, // D2
    filterCutoff: 650,
    resonance: 3.5,
    chords: [
      [146.83, 174.61, 220.0, 261.63], // Dm7
      [174.61, 220.0, 261.63, 329.63], // Fmaj7
      [130.81, 164.81, 196.0, 246.94], // Cmaj7
      [116.54, 146.83, 174.61, 220.0]  // Bbmaj7
    ],
    noiseColor: "pink",
    noiseGain: 0.03,
    tempo: 7.5
  },
  crimson: {
    id: "crimson",
    name: "Warm Sunset Ember",
    themeColor: "crimson",
    mood: "Analog Lo-Fi Warmth",
    baseFreqs: [110.0, 164.81, 196.0, 246.94], // A2, E3, G3, B3 (Am9)
    droneFreq: 55.0, // A1
    filterCutoff: 520,
    resonance: 2.8,
    chords: [
      [110.0, 164.81, 196.0, 246.94], // Am9
      [87.31, 130.81, 174.61, 220.0],  // Fmaj7
      [130.81, 164.81, 196.0, 246.94], // Cmaj7
      [98.0, 146.83, 196.0, 246.94]   // G6
    ],
    noiseColor: "brown",
    noiseGain: 0.045,
    tempo: 8.0
  },
  emerald: {
    id: "emerald",
    name: "Zen Bamboo Grove",
    themeColor: "emerald",
    mood: "Tranquil Nature Zen",
    baseFreqs: [196.0, 220.0, 293.66, 329.63, 392.0], // G, A, D, E, G (Pentatonic)
    droneFreq: 98.0, // G2
    filterCutoff: 800,
    resonance: 1.5,
    chords: [
      [196.0, 246.94, 293.66, 392.0], // G add9
      [220.0, 261.63, 329.63, 440.0], // Am7
      [146.83, 220.0, 293.66, 369.99],// D add9
      [164.81, 246.94, 329.63, 392.0] // Em7
    ],
    noiseColor: "pink",
    noiseGain: 0.025,
    tempo: 6.5
  },
  celestial: {
    id: "celestial",
    name: "Starlight Serenade",
    themeColor: "celestial",
    mood: "Crystal Space Shimmer",
    baseFreqs: [174.61, 261.63, 329.63, 392.0], // F3, C4, E4, G4 (Fmaj9)
    droneFreq: 87.31, // F2
    filterCutoff: 950,
    resonance: 4.2,
    chords: [
      [174.61, 261.63, 329.63, 392.0], // Fmaj9
      [130.81, 196.0, 246.94, 293.66], // Cmaj9
      [146.83, 220.0, 261.63, 329.63], // Dm9
      [164.81, 246.94, 329.63, 392.0]  // Em7
    ],
    noiseColor: "white",
    noiseGain: 0.02,
    tempo: 7.0
  },
  gold: {
    id: "gold",
    name: "Solar Radiance",
    themeColor: "gold",
    mood: "Uplifting Golden Pulse",
    baseFreqs: [130.81, 196.0, 261.63, 329.63], // C3, G3, C4, E4
    droneFreq: 65.41, // C2
    filterCutoff: 750,
    resonance: 3.0,
    chords: [
      [130.81, 196.0, 246.94, 329.63], // Cmaj7
      [146.83, 220.0, 261.63, 369.99], // D6
      [164.81, 246.94, 329.63, 392.0], // Em7
      [174.61, 220.0, 261.63, 329.63]  // Fmaj7
    ],
    noiseColor: "pink",
    noiseGain: 0.02,
    tempo: 6.0
  },
  rose: {
    id: "rose",
    name: "Cherry Blossom Whisper",
    themeColor: "rose",
    mood: "Romantic Pastel Melancholy",
    baseFreqs: [155.56, 233.08, 311.13, 392.0], // Eb3, Bb3, Eb4, G4 (Ebmaj7)
    droneFreq: 77.78, // Eb2
    filterCutoff: 580,
    resonance: 2.2,
    chords: [
      [155.56, 233.08, 311.13, 392.0], // Ebmaj7
      [130.81, 196.0, 261.63, 311.13], // Cm7
      [103.83, 155.56, 207.65, 261.63],// Abmaj7
      [116.54, 174.61, 233.08, 293.66] // Bb7
    ],
    noiseColor: "brown",
    noiseGain: 0.04,
    tempo: 8.5
  },
  charcoal: {
    id: "charcoal",
    name: "Midnight Cyberpulse",
    themeColor: "charcoal",
    mood: "Hypnotic Cyber Sub-Bass",
    baseFreqs: [110.0, 164.81, 220.0, 277.18], // A2, E3, A3, C#4 (A maj)
    droneFreq: 55.0, // A1 sub
    filterCutoff: 420,
    resonance: 2.0,
    chords: [
      [110.0, 164.81, 220.0, 277.18], // A
      [98.0, 146.83, 196.0, 246.94],  // G
      [87.31, 130.81, 174.61, 220.0],  // F
      [98.0, 146.83, 196.0, 246.94]   // G
    ],
    noiseColor: "brown",
    noiseGain: 0.035,
    tempo: 9.0
  }
};

export class AtmosphereEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private droneOsc: OscillatorNode | null = null;
  private droneGain: GainNode | null = null;
  private filterNode: BiquadFilterNode | null = null;
  private noiseNode: AudioBufferSourceNode | null = null;
  private noiseGainNode: GainNode | null = null;
  private lfoOsc: OscillatorNode | null = null;
  private lfoGain: GainNode | null = null;

  // Chord synthesizer state
  private chordOscs: OscillatorNode[] = [];
  private chordGains: GainNode[] = [];
  private chordInterval: any = null;
  private currentChordIndex = 0;

  // Configuration
  private currentTheme = "charcoal";
  private isRunning = false;
  private volume = 0.45;
  private isMuted = false;
  private textureMode: "all" | "chords" | "drone" | "tape" = "all";

  // Event listener
  private onStateUpdate?: (state: { isPlaying: boolean; currentPreset: SoundscapePreset; volume: number }) => void;

  constructor(theme: string = "charcoal", onUpdate?: (state: any) => void) {
    this.currentTheme = theme;
    this.onStateUpdate = onUpdate;

    // Restore saved settings
    try {
      const savedVol = localStorage.getItem("lohz_atmosphere_vol") || localStorage.getItem("myraa_atmosphere_vol");
      if (savedVol !== null) this.volume = parseFloat(savedVol);
      const savedTexture = localStorage.getItem("lohz_atmosphere_texture") || localStorage.getItem("myraa_atmosphere_texture");
      if (savedTexture) this.textureMode = savedTexture as any;
    } catch {}
  }

  private getPreset(): SoundscapePreset {
    return ATMOSPHERE_PRESETS[this.currentTheme] || ATMOSPHERE_PRESETS.charcoal;
  }

  public getActivePreset(): SoundscapePreset {
    return this.getPreset();
  }

  public getVolume(): number {
    return this.volume;
  }

  public getIsPlaying(): boolean {
    return this.isRunning && !this.isMuted;
  }

  public getTextureMode(): string {
    return this.textureMode;
  }

  private emitUpdate() {
    if (this.onStateUpdate) {
      this.onStateUpdate({
        isPlaying: this.getIsPlaying(),
        currentPreset: this.getActivePreset(),
        volume: this.volume
      });
    }
  }

  /**
   * Initializes Web Audio context and graph.
   */
  private async initAudio() {
    if (this.ctx && this.ctx.state !== "closed") {
      if (this.ctx.state === "suspended") {
        await this.ctx.resume();
      }
      return;
    }

    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    this.ctx = new AudioContextClass();

    if (this.ctx.state === "suspended") {
      await this.ctx.resume().catch(() => {});
    }

    // Master Gain
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.setValueAtTime(this.isMuted ? 0 : this.volume * 0.35, this.ctx.currentTime);
    this.masterGain.connect(this.ctx.destination);

    // Warm Lowpass Filter with gentle resonance
    this.filterNode = this.ctx.createBiquadFilter();
    this.filterNode.type = "lowpass";
    this.filterNode.frequency.setValueAtTime(this.getPreset().filterCutoff, this.ctx.currentTime);
    this.filterNode.Q.setValueAtTime(this.getPreset().resonance, this.ctx.currentTime);
    this.filterNode.connect(this.masterGain);

    // Slow LFO for organic filter sweep (breathing effect)
    this.lfoOsc = this.ctx.createOscillator();
    this.lfoOsc.type = "sine";
    this.lfoOsc.frequency.setValueAtTime(0.08, this.ctx.currentTime); // Very slow 12-second cycle

    this.lfoGain = this.ctx.createGain();
    this.lfoGain.gain.setValueAtTime(140, this.ctx.currentTime);

    this.lfoOsc.connect(this.lfoGain);
    this.lfoGain.connect(this.filterNode.frequency);
    this.lfoOsc.start();

    // Create Organic Tape Noise / Ambient Vinyl Hiss
    this.setupNoiseGenerator();

    // Setup Deep Ambient Sub-Drone
    this.setupDrone();
  }

  /**
   * Generates low-fidelity pink/brown noise texture (vinyl crackle / tape hiss / gentle rain)
   */
  private setupNoiseGenerator() {
    if (!this.ctx || !this.masterGain) return;

    try {
      const bufferSize = this.ctx.sampleRate * 3; // 3-second noise loop
      const noiseBuffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
      const output = noiseBuffer.getChannelData(0);

      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      for (let i = 0; i < bufferSize; i++) {
        const white = Math.random() * 2 - 1;
        // Paul Kellet's filtered pink noise algorithm
        b0 = 0.99886 * b0 + white * 0.0555179;
        b1 = 0.99332 * b1 + white * 0.0750759;
        b2 = 0.96900 * b2 + white * 0.1538520;
        b3 = 0.86650 * b3 + white * 0.3104856;
        b4 = 0.55000 * b4 + white * 0.5329522;
        b5 = -0.7616 * b5 - white * 0.0168980;
        output[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.08;
        b6 = white * 0.115926;
      }

      this.noiseNode = this.ctx.createBufferSource();
      this.noiseNode.buffer = noiseBuffer;
      this.noiseNode.loop = true;

      // Bandpass filter for tape warmth
      const noiseFilter = this.ctx.createBiquadFilter();
      noiseFilter.type = "bandpass";
      noiseFilter.frequency.setValueAtTime(1200, this.ctx.currentTime);
      noiseFilter.Q.setValueAtTime(1.0, this.ctx.currentTime);

      this.noiseGainNode = this.ctx.createGain();
      const preset = this.getPreset();
      this.noiseGainNode.gain.setValueAtTime(preset.noiseGain * 0.6, this.ctx.currentTime);

      this.noiseNode.connect(noiseFilter);
      noiseFilter.connect(this.noiseGainNode);
      this.noiseGainNode.connect(this.masterGain);

      this.noiseNode.start();
    } catch (e) {
      console.warn("[Atmosphere] Noise generator init error:", e);
    }
  }

  /**
   * Sets up deep, warm fundamental sub-drone.
   */
  private setupDrone() {
    if (!this.ctx || !this.filterNode) return;

    try {
      const preset = this.getPreset();
      this.droneOsc = this.ctx.createOscillator();
      this.droneOsc.type = "sine";
      this.droneOsc.frequency.setValueAtTime(preset.droneFreq, this.ctx.currentTime);

      // Add a subtle second detuned harmonic for rich warmth
      const subOsc = this.ctx.createOscillator();
      subOsc.type = "triangle";
      subOsc.frequency.setValueAtTime(preset.droneFreq * 1.5, this.ctx.currentTime);

      this.droneGain = this.ctx.createGain();
      this.droneGain.gain.setValueAtTime(0.12, this.ctx.currentTime);

      this.droneOsc.connect(this.droneGain);
      subOsc.connect(this.droneGain);
      this.droneGain.connect(this.filterNode);

      this.droneOsc.start();
      subOsc.start();
    } catch (e) {
      console.warn("[Atmosphere] Drone setup error:", e);
    }
  }

  /**
   * Plays a smooth procedural multi-oscillator chord swell.
   */
  private playChord(chordFreqs: number[], durationSec: number) {
    if (!this.ctx || !this.filterNode) return;

    const now = this.ctx.currentTime;
    const attack = Math.min(2.8, durationSec * 0.4);
    const release = Math.min(3.2, durationSec * 0.45);

    chordFreqs.forEach((freq, i) => {
      if (!this.ctx || !this.filterNode) return;

      const osc = this.ctx.createOscillator();
      // Gentle warm waveforms: mix of sine and softened triangle
      osc.type = i % 2 === 0 ? "sine" : "triangle";
      
      // Micro-detune for lush stereo chorus width
      const detuneCents = (Math.random() * 8 - 4) + (i === 0 ? -2 : i === 1 ? 3 : -1);
      osc.detune.setValueAtTime(detuneCents, now);
      osc.frequency.setValueAtTime(freq, now);

      const gain = this.ctx.createGain();
      gain.gain.setValueAtTime(0.0001, now);
      
      // Smooth bell curve envelope
      gain.gain.exponentialRampToValueAtTime(0.06 / Math.sqrt(chordFreqs.length), now + attack);
      gain.gain.exponentialRampToValueAtTime(0.00001, now + durationSec + release);

      osc.connect(gain);
      gain.connect(this.filterNode);

      osc.start(now);
      osc.stop(now + durationSec + release + 0.5);

      // Clean reference on stop
      setTimeout(() => {
        try {
          osc.disconnect();
          gain.disconnect();
        } catch {}
      }, (durationSec + release + 1) * 1000);
    });
  }

  /**
   * Starts chord progression loop scheduler.
   */
  private startChordProgression() {
    this.stopChordProgression();

    const triggerNextChord = () => {
      if (!this.isRunning || !this.ctx) return;
      const preset = this.getPreset();
      const chords = preset.chords;
      if (!chords || chords.length === 0) return;

      const chord = chords[this.currentChordIndex % chords.length];
      this.currentChordIndex = (this.currentChordIndex + 1) % chords.length;

      this.playChord(chord, preset.tempo);
    };

    triggerNextChord();
    const preset = this.getPreset();
    this.chordInterval = setInterval(triggerNextChord, preset.tempo * 1000);
  }

  private stopChordProgression() {
    if (this.chordInterval) {
      clearInterval(this.chordInterval);
      this.chordInterval = null;
    }
  }

  /**
   * Starts playing the atmosphere soundscape.
   */
  public async play() {
    try {
      await this.initAudio();
      this.isRunning = true;
      this.isMuted = false;

      if (this.ctx && this.masterGain) {
        this.masterGain.gain.cancelScheduledValues(this.ctx.currentTime);
        this.masterGain.gain.setValueAtTime(0.0001, this.ctx.currentTime);
        this.masterGain.gain.linearRampToValueAtTime(this.volume * 0.35, this.ctx.currentTime + 1.5);
      }

      this.startChordProgression();
      this.emitUpdate();
    } catch (err) {
      console.error("[Atmosphere Engine] Play error:", err);
    }
  }

  /**
   * Pauses / stops the atmosphere soundscape with gentle fadeout.
   */
  public pause() {
    if (!this.isRunning) return;
    this.isRunning = false;
    this.stopChordProgression();

    if (this.ctx && this.masterGain) {
      const now = this.ctx.currentTime;
      this.masterGain.gain.cancelScheduledValues(now);
      this.masterGain.gain.setValueAtTime(this.masterGain.gain.value, now);
      this.masterGain.gain.linearRampToValueAtTime(0.0001, now + 0.8);
    }

    this.emitUpdate();
  }

  /**
   * Toggles playback state.
   */
  public toggle() {
    if (this.isRunning) {
      this.pause();
    } else {
      this.play();
    }
  }

  /**
   * Dynamically shifts theme color and crossfades to matching soundscape.
   */
  public setTheme(newTheme: string) {
    if (this.currentTheme === newTheme) return;
    this.currentTheme = newTheme;
    const preset = this.getPreset();

    if (this.ctx && this.filterNode) {
      const now = this.ctx.currentTime;
      // Smoothly morph filter and drone frequencies
      this.filterNode.frequency.cancelScheduledValues(now);
      this.filterNode.frequency.linearRampToValueAtTime(preset.filterCutoff, now + 3.0);
      this.filterNode.Q.linearRampToValueAtTime(preset.resonance, now + 2.0);

      if (this.droneOsc) {
        this.droneOsc.frequency.cancelScheduledValues(now);
        this.droneOsc.frequency.linearRampToValueAtTime(preset.droneFreq, now + 2.5);
      }

      if (this.noiseGainNode) {
        this.noiseGainNode.gain.cancelScheduledValues(now);
        this.noiseGainNode.gain.linearRampToValueAtTime(preset.noiseGain * 0.6, now + 2.0);
      }
    }

    if (this.isRunning) {
      this.currentChordIndex = 0;
      this.startChordProgression();
    }

    this.emitUpdate();
  }

  /**
   * Adjusts master atmosphere volume (0.0 to 1.0)
   */
  public setVolume(newVol: number) {
    this.volume = Math.max(0, Math.min(1, newVol));
    try {
      localStorage.setItem("lohz_atmosphere_vol", this.volume.toString());
    } catch {}

    if (this.ctx && this.masterGain && this.isRunning && !this.isMuted) {
      const now = this.ctx.currentTime;
      this.masterGain.gain.cancelScheduledValues(now);
      this.masterGain.gain.linearRampToValueAtTime(this.volume * 0.35, now + 0.1);
    }

    this.emitUpdate();
  }

  public setTextureMode(mode: "all" | "chords" | "drone" | "tape") {
    this.textureMode = mode;
    try {
      localStorage.setItem("lohz_atmosphere_texture", mode);
    } catch {}

    if (this.ctx) {
      const now = this.ctx.currentTime;
      if (this.droneGain) {
        const droneVol = (mode === "all" || mode === "drone") ? 0.12 : 0.0001;
        this.droneGain.gain.linearRampToValueAtTime(droneVol, now + 0.5);
      }
      if (this.noiseGainNode) {
        const noiseVol = (mode === "all" || mode === "tape") ? this.getPreset().noiseGain * 0.6 : 0.0001;
        this.noiseGainNode.gain.linearRampToValueAtTime(noiseVol, now + 0.5);
      }
    }

    this.emitUpdate();
  }
}
