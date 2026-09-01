/**
 * Audio handling utility for LOHZ Live API Voice stream.
 * Handles:
 * - 16kHz layout sampling for microphone stream.
 * - Raw Little Endian Int16 PCM translation.
 * - 24kHz layout output sampling for model voice playback.
 * - Gapless double-buffer queue scheduler.
 * - Interrupt signal immediate stop.
 * - Input & Output AnalyserNodes for real-time waveform visuals.
 */

export type LiveState = "disconnected" | "connecting" | "listening" | "speaking";
import type { ConversationMode, ConversationParticipantState, SpeakerTurn } from "./conversation/types";

export interface LiveTranscriptionEvent {
  role: "user" | "model";
  text: string;
  turn?: SpeakerTurn;
}

// Agent status from Windows Agent
import type { AgentStatus } from "../../windows-agent/types";

// Resampling Helper: cleanly downsamples Float32Array from native sampleRate to target 16kHz
function resampleTo16k(inputData: Float32Array, inputSampleRate: number): Float32Array {
  if (inputSampleRate === 16000) return inputData;
  const ratio = inputSampleRate / 16000;
  const newLength = Math.round(inputData.length / ratio);
  const result = new Float32Array(newLength);
  
  for (let i = 0; i < newLength; i++) {
    const srcIndex = i * ratio;
    const i0 = Math.floor(srcIndex);
    const i1 = Math.min(i0 + 1, inputData.length - 1);
    const weight = srcIndex - i0;
    result[i] = inputData[i0] * (1 - weight) + inputData[i1] * weight;
  }
  return result;
}

// PCM Conversion Helper: converts Float32Array [-1.0, 1.0] to signed Int16 Raw PCM Little Endian
function floatTo16BitPCM(input: Float32Array): ArrayBuffer {
  const buffer = new ArrayBuffer(input.length * 2);
  const view = new DataView(buffer);
  let offset = 0;
  for (let i = 0; i < input.length; i++, offset += 2) {
    let s = Math.max(-1, Math.min(1, input[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }
  return buffer;
}

// Float conversion helper: converts signed Int16 array buffer to Float32Array [-1.0, 1.0]
function pcm16ToFloats(uint8Array: Uint8Array): Float32Array {
  const int16 = new Int16Array(
    uint8Array.buffer,
    uint8Array.byteOffset,
    uint8Array.byteLength / 2
  );
  const floats = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    floats[i] = int16[i] / 32768.0;
  }
  return floats;
}

// Convert ArrayBuffer to Base64 String
function base64ArrayBuffer(arrayBuffer: ArrayBuffer): string {
  let binary = '';
  const bytes = new Uint8Array(arrayBuffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary);
}

// Convert Base64 string to Uint8Array
function base64ToUint8Array(base64: string): Uint8Array {
  const binaryString = window.atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

export class LohzAudioSession {
  private ws: WebSocket | null = null;
  
  // Audios contexts (separate to match exact required sample rates)
  private inputAudioCtx: AudioContext | null = null;
  private outputAudioCtx: AudioContext | null = null;
  
  // Audio sources & processors
  private micStream: MediaStream | null = null;
  private micSourceNode: MediaStreamAudioSourceNode | null = null;
  private micProcessorNode: ScriptProcessorNode | null = null;
  
  // Visualisers
  public inputAnalyser: AnalyserNode | null = null;
  public outputAnalyser: AnalyserNode | null = null;
  private outputGainNode: GainNode | null = null;
  
// Buffering / Playback details
  private nextStartTime = 0;
  private activeSources: AudioBufferSourceNode[] = [];
  
  // Voice Modulator settings
  private playbackSpeed = 1.0;
  private pitchShiftCents = 0;
  
  // State Callbacks
  private onStateChange: (state: LiveState) => void;
  private onTranscription: (role: "user" | "model", text: string, turn?: SpeakerTurn) => void;
  private onToolCall: (name: string, args: any, callback: (result: any) => void) => void;
  private onError: (error: string) => void;
  private onMemorySync?: (memories: any[]) => void;
  private onAgentStatus?: (status: AgentStatus) => void;
  private onConversationState?: (state: ConversationParticipantState) => void;
  private conversationMode: ConversationMode = "single_user";
  
  // Flag to prevent processing own transcriptions to avoid welcome message loops
  private _processingOwnTranscription = false;
  
  private currentState: LiveState = "disconnected";
  private isActivated = false;
  private hasTriggeredWelcome = false;

  constructor(handlers: {
    onStateChange: (state: LiveState) => void;
    onTranscription: (role: "user" | "model", text: string, turn?: SpeakerTurn) => void;
    onToolCall: (name: string, args: any, callback: (result: any) => void) => void;
    onError: (error: string) => void;
    onAgentStatus?: (status: AgentStatus) => void;
    onMemorySync?: (memories: any[]) => void;
    onConversationState?: (state: ConversationParticipantState) => void;
  }) {
    this.onStateChange = handlers.onStateChange;
    this.onTranscription = handlers.onTranscription;
    this.onToolCall = handlers.onToolCall;
    this.onError = handlers.onError;
    this.onMemorySync = handlers.onMemorySync;
    this.onAgentStatus = handlers.onAgentStatus;
    this.onConversationState = handlers.onConversationState;
  }

  private setState(state: LiveState) {
    this.currentState = state;
    this.onStateChange(state);
  }

  public getState(): LiveState {
    return this.currentState;
  }

  /**
   * Triggers LOHZ to audibly greet the user immediately upon successful connection.
   */
  public triggerWelcomeGreeting() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN && !this.hasTriggeredWelcome) {
      this.hasTriggeredWelcome = true;
      console.log("[LOHZ Audio] Dispatching initWelcome cue to server bridge");
      this.ws.send(JSON.stringify({ type: "initWelcome" }));
    }
  }

  /**
   * Sends a text message to the server for Gemini processing (text-only path, no audio).
   */
  public sendTextMessage(text: string) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.currentState !== "disconnected") {
      this.ws.send(JSON.stringify({ type: "text", text }));
    }
  }

  /** Group mode changes attribution only; it never changes authentication. */
  public setConversationMode(mode: ConversationMode) {
    this.conversationMode = mode;
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "conversation_mode", mode }));
    }
  }

  /**
   * Pushes a compressed JPEG base64 screenshot frame directly to the live WebSocket server.
   */
  public sendVideoFrame(base64Data: string) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.currentState !== "disconnected") {
      this.ws.send(JSON.stringify({ type: "video", video: base64Data }));
    }
  }

  /**
   * Modulate playback speed dynamically (e.g. 0.7x to 1.4x)
   */
  public setPlaybackSpeed(speed: number) {
    this.playbackSpeed = Math.max(0.6, Math.min(1.6, speed));
    // Apply immediately to any currently playing source nodes
    this.activeSources.forEach((source) => {
      try {
        source.playbackRate.setValueAtTime(this.playbackSpeed, this.outputAudioCtx?.currentTime || 0);
      } catch (err) {}
    });
  }

  /**
   * Modulate voice pitch in cents dynamically (e.g. -800 to +800 cents; 100 cents = 1 semitone)
   */
  public setVoicePitch(cents: number) {
    this.pitchShiftCents = Math.max(-1200, Math.min(1200, cents));
    // Apply immediately to any currently playing source nodes
    this.activeSources.forEach((source) => {
      try {
        if (source.detune) {
          source.detune.setValueAtTime(this.pitchShiftCents, this.outputAudioCtx?.currentTime || 0);
        }
      } catch (err) {}
    });
  }

  public getVoiceSettings() {
    return {
      speed: this.playbackSpeed,
      pitchCents: this.pitchShiftCents,
    };
  }

  // Requests microphone and creates connections
  public async connect(authToken?: string) {
    if (this.isActivated) return;
    this.isActivated = true;
    this.setState("connecting");

    try {
      // 1. Establish custom WebSocket server bridge
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const wsUrl = authToken
        ? `${protocol}//${window.location.host}/live?token=${encodeURIComponent(authToken)}`
        : `${protocol}//${window.location.host}/live`;
      this.ws = new WebSocket(wsUrl);
      this.ws.binaryType = "blob";

      this.ws.onopen = async () => {
        console.log("[LOHZ] Connected to server side WS bridge");
        this.ws?.send(JSON.stringify({ type: "conversation_mode", mode: this.conversationMode }));
        try {
          // Guard against early user disconnect during connection setup
          if (!this.isActivated) return;

          // Safe, cross-browser AudioContext initialization using native hardware sample rate
          const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
          if (!AudioContextClass) {
            throw new Error("Holographic audio link unsupported: Web Audio API missing in browser.");
          }

          // Use native hardware rate to ensure createMediaStreamSource compatibility on all platforms
          this.inputAudioCtx = new AudioContextClass();
          this.outputAudioCtx = new AudioContextClass();

          // Ensure Audio Contexts are active and resumed to bypass browser security blocks
          if (this.inputAudioCtx.state === "suspended") {
            await this.inputAudioCtx.resume().catch(() => {});
          }
          if (this.outputAudioCtx.state === "suspended") {
            await this.outputAudioCtx.resume().catch(() => {});
          }
          
          // Setup custom output Analyser & Volume Gains
          this.outputGainNode = this.outputAudioCtx.createGain();
          this.outputGainNode.gain.setValueAtTime(1.0, this.outputAudioCtx.currentTime);
          this.outputAnalyser = this.outputAudioCtx.createAnalyser();
          this.outputAnalyser.fftSize = 256;
          this.outputAnalyser.smoothingTimeConstant = 0.8;
          
          this.outputGainNode.connect(this.outputAnalyser);
          this.outputAnalyser.connect(this.outputAudioCtx.destination);
          
          // Obtain User Microphone layout with graceful fallback constraints
          let stream: MediaStream | null = null;
          try {
            stream = await navigator.mediaDevices.getUserMedia({
              audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
              }
            });
          } catch (strictErr) {
            console.warn("[LOHZ Audio] Enhanced mic constraints failed, trying basic audio stream:", strictErr);
            try {
              stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            } catch (basicErr) {
              console.warn("[LOHZ Audio] Basic microphone stream also unavailable:", basicErr);
            }
          }

          // Safeguard: Check if we disconnected while waiting for user to grant mic permissions
          if (!this.isActivated || !this.inputAudioCtx || !this.outputAudioCtx) {
            if (stream) {
              stream.getTracks().forEach((track) => {
                try {
                  track.stop();
                } catch (e) {}
              });
            }
            return;
          }

          if (stream) {
            this.micStream = stream;

            // Setup custom input Analyser
            this.inputAnalyser = this.inputAudioCtx.createAnalyser();
            this.inputAnalyser.fftSize = 256;
            
            this.micSourceNode = this.inputAudioCtx.createMediaStreamSource(this.micStream);
            this.micSourceNode.connect(this.inputAnalyser);

            // Stream input PCM 16-bit to WS with high-fidelity linear resampling to 16kHz
            const sampleRate = this.inputAudioCtx.sampleRate;
            this.micProcessorNode = this.inputAudioCtx.createScriptProcessor(4096, 1, 1);
            this.micSourceNode.connect(this.micProcessorNode);

            // Route through a zero-gain node to destination to prevent mic feedback howling
            const silentGain = this.inputAudioCtx.createGain();
            silentGain.gain.setValueAtTime(0, this.inputAudioCtx.currentTime);
            this.micProcessorNode.connect(silentGain);
            silentGain.connect(this.inputAudioCtx.destination);

            this.micProcessorNode.onaudioprocess = (e) => {
              if (this.currentState === "disconnected" || this.currentState === "connecting") return;
              
              const channelData = e.inputBuffer.getChannelData(0);
              const resampled = resampleTo16k(channelData, sampleRate);
              
              // Convert to base64 Int16 Little Endian PCM
              const pcmBuffer = floatTo16BitPCM(resampled);
              const base64 = base64ArrayBuffer(pcmBuffer);
              
              if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({ audio: base64 }));
              }
            };
          } else {
            console.warn("[LOHZ Audio] Connected in Speaker & Multimodal Vision mode without microphone input.");
          }

          // Sound setups are fully functional
          this.setState("listening");

        } catch (audioError: any) {
          console.error("Audio Context or Microphone Initialization Failed:", audioError);
          this.onError(`Audio setup note: ${audioError.message || "Microphone required for voice link."}`);
          this.disconnect();
        }
      };

      this.ws.onmessage = async (event) => {
        try {
          const data = JSON.parse(event.data);
          
          // Root Error Handler message
          if (data.type === "error") {
            this.onError(data.error);
            this.disconnect();
            return;
          }

          // Handle server-side states
          if (data.type === "status") {
            console.log("[LOHZ WS Status]:", data.status);
            if (data.status === "connecting_gemini") {
              // Wait for Gemini Live connection
            } else if (data.status === "connected") {
              this.setState("listening");
              // Trigger initial welcome greeting so LOHZ immediately speaks upon first successful connection
              setTimeout(() => {
                this.triggerWelcomeGreeting();
              }, 250);
            } else if (data.status === "session_closed") {
              this.disconnect();
            }
            return;
          }

          // Handle audio payload (24kHzPCM model response)
          if (data.type === "audio" && data.audio) {
            this.playAudioPCMChunk(data.audio);
          }

          // Handle interruption signal (e.g. user talked over LOHZ)
          if (data.type === "interrupted") {
            this.handleInterruption();
          }

          // Turn complete
          if (data.type === "turnComplete") {
            // Once LOHZ completes speaking, change visual state back to listening
            setTimeout(() => {
              if (this.activeSources.length === 0 && this.currentState === "speaking") {
                this.setState("listening");
              }
            }, 100);
          }

          if (data.type === "conversation_state" && data.state) {
            this.onConversationState?.(data.state as ConversationParticipantState);
            return;
          }

// Handle live captions transcription
if (data.type === "transcription") {
  // Server emits only finalized user turns; model text remains caption data.
  if (data.role === "user" && !this._processingOwnTranscription) {
    this.onTranscription(data.role, data.text, data.turn);
  } else if (data.role === "model") {
    this.onTranscription(data.role, data.text, data.turn);
  }
  // Reset the flag after a short delay
  if (data.role === "model") {
    this._processingOwnTranscription = true;
    setTimeout(() => {
      this._processingOwnTranscription = false;
    }, 500);
  }
}

          // Handle memory synchronization
          if (data.type === "memory_sync" && data.memories) {
            if (this.onMemorySync) {
              this.onMemorySync(data.memories);
            }
          }

          // Handle agent status updates from Windows Agent
          if (data.type === "agent_status" && data.status) {
            if (this.onAgentStatus) {
              this.onAgentStatus(data.status);
            }
          }

          // Handle Tool Calling
          if (data.type === "toolCall") {
            const { callId, name, args } = data;
            this.onToolCall(name, args, (result) => {
              // Send back execution result to server bridge
              if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({
                  type: "toolResponse",
                  id: callId,
                  name: name,
                  output: result
                }));
              }
            });
          }

        } catch (parseError) {
          console.error("Error reading server packet:", parseError);
        }
      };

      this.ws.onerror = (wsError) => {
        console.error("WebSocket transport error:", wsError);
        this.onError("Holographic network link lost. Please check connection.");
        this.disconnect();
      };

      this.ws.onclose = () => {
        console.log("WebSocket connection closed");
        this.disconnect();
      };

    } catch (e: any) {
      console.error("Connection establish sequence failed:", e);
      this.onError(e.message || "Failed to initialize active channel.");
      this.disconnect();
    }
  }

  // Interruption triggers: stops all active audio players immediately
  private handleInterruption() {
    console.log("[Audio] Interruption signal received; flushing play logs.");
    
    // Stop all playing nodes
    this.activeSources.forEach((source) => {
      try {
        source.stop();
      } catch (err) {
        // Already finished or stopped
      }
    });
    this.activeSources = [];
    this.nextStartTime = 0;
    
    // Set state back to user listening
    this.setState("listening");
  }

  // Direct raw PCM chunk scheduled playback at 24kHz
  private playAudioPCMChunk(base64Audio: string) {
    if (!this.outputAudioCtx || !this.outputGainNode) return;

    try {
      this.setState("speaking");
      const uint8Array = base64ToUint8Array(base64Audio);
      const floats = pcm16ToFloats(uint8Array);

      // Create AudioBuffer of 24000Hz (the exact playback sample rate of Gemini outputs)
      const buffer = this.outputAudioCtx.createBuffer(1, floats.length, 24000);
      buffer.getChannelData(0).set(floats);

      // Create Buffer source
      const source = this.outputAudioCtx.createBufferSource();
      source.buffer = buffer;

      // Apply Voice Pitch & Speed Modulation
      if (source.playbackRate) {
        source.playbackRate.value = this.playbackSpeed;
      }
      if (source.detune && this.pitchShiftCents !== 0) {
        source.detune.value = this.pitchShiftCents;
      }

      // Connect source to gain which is routed to analyser & speakers
      source.connect(this.outputGainNode);

      const currentTime = this.outputAudioCtx.currentTime;
      
      // Gapless scheduler sync
      if (this.nextStartTime < currentTime) {
        // Start fresh: 30ms ahead to bridge schedule timing
        this.nextStartTime = currentTime + 0.03;
      }

      source.start(this.nextStartTime);
      const effectiveDuration = buffer.duration / (this.playbackSpeed || 1.0);
      this.nextStartTime += effectiveDuration;

      // Keep reference to handle real-time interruptions
      source.onended = () => {
        const index = this.activeSources.indexOf(source);
        if (index > -1) {
          this.activeSources.splice(index, 1);
        }
        
        // If there are no more active play nodes, revert state back to listening
        if (this.activeSources.length === 0 && this.currentState === "speaking") {
          this.setState("listening");
        }
      };

      this.activeSources.push(source);

    } catch (playbackError) {
      console.error("PCM Chunk buffering/playback failed:", playbackError);
    }
  }

  // Fully cleanup and release microphones & connection sockets
  public disconnect() {
    this.isActivated = false;
    this.setState("disconnected");

    // Close WS socket
    if (this.ws) {
      try {
        this.ws.close();
      } catch (e) {}
      this.ws = null;
    }

    // Stop and release user microphone streams
    if (this.micStream) {
      this.micStream.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch (e) {}
      });
      this.micStream = null;
    }

    // Disconnect routing nodes
    if (this.micProcessorNode) {
      try {
        this.micProcessorNode.disconnect();
      } catch (e) {}
      this.micProcessorNode = null;
    }

    if (this.micSourceNode) {
      try {
        this.micSourceNode.disconnect();
      } catch (e) {}
      this.micSourceNode = null;
    }

    // Close Audio contexts
    if (this.inputAudioCtx) {
      try {
        this.inputAudioCtx.close();
      } catch (e) {}
      this.inputAudioCtx = null;
    }

    if (this.outputAudioCtx) {
      try {
        this.outputAudioCtx.close();
      } catch (e) {}
      this.outputAudioCtx = null;
    }

    this.activeSources = [];
    this.nextStartTime = 0;
    this.inputAnalyser = null;
    this.outputAnalyser = null;
    this.outputGainNode = null;
    this.hasTriggeredWelcome = false;
  }
}

export { LohzAudioSession as MyraaAudioSession };
