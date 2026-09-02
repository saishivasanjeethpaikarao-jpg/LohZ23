import { useState, useEffect, useRef, useCallback } from "react";
import { LohzAudioSession, LiveState } from "./lib/audio";
import { LohzCoreVisualizer, LohzEmotion } from "./components/LohzCoreVisualizer";
import { BrowserAgent } from "./components/BrowserAgent";
import { Settings } from "./components/Settings";
import { TextInput } from "./components/TextInput";
import { TranscriptionPanel, TranscriptEntry } from "./components/TranscriptionPanel";
import { Settings as SettingsIcon } from "lucide-react";
import { AgentStatus } from "../windows-agent/types";
import { 
  Power, 
  Volume2, 
  Info, 
  Sparkles, 
  Globe, 
  Maximize2, 
  MessageSquareOff,
  MessageSquare,
  Compass, 
  CircleAlert,
  MicOff,
  Mic,
  X,
  Brain,
  Monitor,
  Play,
  Pause,
  Square,
  RefreshCw,
  BarChart3,
  Headphones,
  Sliders,
  Radio,
  Keyboard,
  User,
  LogIn,
  Users,
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { Memory, MemoryCategory } from "./lib/memoryTypes";
import { MemoryDashboard } from "./components/MemoryDashboard";
import { Tooltip } from "./components/Tooltip";
import { AtmosphereEngine } from "./lib/atmosphere";
import { AtmosphereController } from "./components/AtmosphereController";
import { ScreenShareStatsOverlay, ScreenShareStats } from "./components/ScreenShareStatsOverlay";
import { useVoiceMemory } from "./hooks/useVoiceMemory";
import { analyzeSentiment, SentimentAnalysisResult } from "./lib/sentiment";
import { VoiceModulatorPanel } from "./components/VoiceModulatorPanel";
import { CognitiveLoop, CognitiveLoopCallbacks } from "./lib/cognitiveLoop";
import { BrainObservability } from "./lib/brainObservability";
import { CognitiveEvent, CognitiveDecision } from "./lib/cognitiveState";
import { MemoryRetrieval } from "./lib/memoryRetrieval";
import { useAuth } from "./contexts/AuthContext";
import type { ConversationMode, ConversationParticipantState, SpeakerTurn } from "./lib/conversation/types";

export default function App() {
  const { user, getIdToken } = useAuth();
  const [state, setState] = useState<LiveState>("disconnected");

  // Real-time Screen Sharing states
  const [isScreenSharing, setIsScreenSharing] = useState<boolean>(false);
  const [isScreenSharingPaused, setIsScreenSharingPaused] = useState<boolean>(false);
  const [screenVisionMode, setScreenVisionMode] = useState<boolean>(true);

  // Screen Sharing Analytics / Usage Telemetry state
  const [screenShareStats, setScreenShareStats] = useState<ScreenShareStats>({
    sessionStartTime: null,
    currentSessionSeconds: 0,
    totalHistoricalSeconds: 0,
    framesCaptured: 0,
    totalPayloadBytes: 0,
    currentResolution: { width: 0, height: 0 },
    targetResolution: { width: 0, height: 0 },
    recentFrameTimestamps: [],
    isPaused: false,
    visionModeActive: true
  });
  const [showScreenShareStats, setShowScreenShareStats] = useState<boolean>(false);

  // References to preserve state across intervals
  const screenStreamRef = useRef<MediaStream | null>(null);
  const screenVideoRef = useRef<HTMLVideoElement | null>(null);
  const screenCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const screenIntervalRef = useRef<any>(null);

  const isPausedRef = useRef<boolean>(false);
  const screenVisionRef = useRef<boolean>(true);
  const stateRef = useRef<LiveState>("disconnected");

  // Atmosphere Ambient Lo-Fi Audio Engine
  const atmosphereEngineRef = useRef<AtmosphereEngine | null>(null);
  const [isAtmospherePlaying, setIsAtmospherePlaying] = useState<boolean>(false);

  // Windows Agent connection status
  const [agentStatus, setAgentStatus] = useState<AgentStatus | null>(null);
  
  // Settings visibility
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [initialSettingsTab, setInitialSettingsTab] = useState<"providers" | "agent" | "voice" | "general" | "security" | "account">("providers");
  const [proactiveSpeechEnabled, setProactiveSpeechEnabled] = useState<boolean>(true);

  // Sync state changes with refs to totally prevent stale closures in callbacks
  useEffect(() => {
    isPausedRef.current = isScreenSharingPaused;
  }, [isScreenSharingPaused]);

  useEffect(() => {
    screenVisionRef.current = screenVisionMode;
  }, [screenVisionMode]);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // Screen Sharing Timer ticker
  useEffect(() => {
    let timer: any = null;
    if (isScreenSharing && !isScreenSharingPaused) {
      timer = setInterval(() => {
        setScreenShareStats((prev) => ({
          ...prev,
          currentSessionSeconds: prev.currentSessionSeconds + 1,
          isPaused: false,
          visionModeActive: screenVisionMode
        }));
      }, 1000);
    }
    return () => {
      if (timer) clearInterval(timer);
    };
  }, [isScreenSharing, isScreenSharingPaused, screenVisionMode]);

  // Clean up streaming intervals on unmount
  useEffect(() => {
    return () => {
      if (screenIntervalRef.current) {
        clearInterval(screenIntervalRef.current);
      }
    };
  }, []);

  const captureFrameAndSend = () => {
    const video = screenVideoRef.current;
    if (!video || isPausedRef.current || !screenVisionRef.current) {
      return;
    }

    if (stateRef.current === "disconnected") {
      return;
    }

    try {
      if (video.videoWidth === 0 || video.videoHeight === 0) return;

      if (!screenCanvasRef.current) {
        screenCanvasRef.current = document.createElement("canvas");
      }
      const canvas = screenCanvasRef.current;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      // Restrict maximum resolution size to keep payload light for Gemini Live
      const maxDim = 960;
      let width = video.videoWidth;
      let height = video.videoHeight;

      if (width > maxDim || height > maxDim) {
        if (width > height) {
          height = Math.round((height * maxDim) / width);
          width = maxDim;
        } else {
          width = Math.round((width * maxDim) / height);
          height = maxDim;
        }
      }

      canvas.width = width;
      canvas.height = height;

      ctx.drawImage(video, 0, 0, width, height);

      // Highly compressed JPEG standard is optimized and preserves details perfectly
      const dataUrl = canvas.toDataURL("image/jpeg", 0.55);
      const base64 = dataUrl.split(",")[1];
      const payloadBytes = Math.round(base64.length * 0.75);

      // Update screen sharing metrics
      setScreenShareStats((prev) => ({
        ...prev,
        framesCaptured: prev.framesCaptured + 1,
        totalPayloadBytes: prev.totalPayloadBytes + payloadBytes,
        currentResolution: { width: video.videoWidth, height: video.videoHeight },
        targetResolution: { width, height },
        recentFrameTimestamps: [...prev.recentFrameTimestamps.slice(-19), Date.now()],
        isPaused: isPausedRef.current,
        visionModeActive: screenVisionRef.current
      }));

      if (sessionRef.current && stateRef.current !== "disconnected") {
        sessionRef.current.sendVideoFrame(base64);
      }
    } catch (err) {
      console.error("[Screen Capture] Failed drawing frame to canvas:", err);
    }
  };

  const startScreenSharing = async () => {
    setErrorText(null);
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 5 }
        },
        audio: false
      });

      screenStreamRef.current = stream;

      const video = document.createElement("video");
      video.srcObject = stream;
      video.muted = true;
      video.playsInline = true;
      video.play().catch(e => console.error("Video play warning:", e));
      screenVideoRef.current = video;

      setIsScreenSharing(true);
      setIsScreenSharingPaused(false);

      // Reset current session timer & record start time
      setScreenShareStats((prev) => ({
        ...prev,
        sessionStartTime: Date.now(),
        currentSessionSeconds: 0,
        isPaused: false,
        visionModeActive: screenVisionMode
      }));

      // Stop handling when native stop sharing bar button ends
      stream.getVideoTracks()[0].onended = () => {
        stopScreenSharing();
      };

      // Set up frame capture interval (one frame every 2 seconds is highly robust, preventing overload)
      if (screenIntervalRef.current) {
        clearInterval(screenIntervalRef.current);
      }
      screenIntervalRef.current = setInterval(() => {
        captureFrameAndSend();
      }, 2000);

      // Promptly capture first frame immediately
      setTimeout(() => {
        captureFrameAndSend();
      }, 500);

    } catch (e: any) {
      console.error("Screen sharing permission declined or missing API:", e);
      if (e.name !== "NotAllowedError") {
        setErrorText(`Could not capture screen: ${e.message || e}`);
      }
    }
  };

  const stopScreenSharing = () => {
    if (screenIntervalRef.current) {
      clearInterval(screenIntervalRef.current);
      screenIntervalRef.current = null;
    }

    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch (e) {}
      });
      screenStreamRef.current = null;
    }

    if (screenVideoRef.current) {
      screenVideoRef.current.pause();
      screenVideoRef.current = null;
    }

    // Accumulate session seconds into total historical seconds
    setScreenShareStats((prev) => ({
      ...prev,
      totalHistoricalSeconds: prev.totalHistoricalSeconds + prev.currentSessionSeconds,
      currentSessionSeconds: 0,
      sessionStartTime: null,
      isPaused: false
    }));

    setIsScreenSharing(false);
    setIsScreenSharingPaused(false);
  };

  const pauseScreenSharing = () => {
    setIsScreenSharingPaused(true);
    setScreenShareStats((prev) => ({ ...prev, isPaused: true }));
  };

  const resumeScreenSharing = () => {
    setIsScreenSharingPaused(false);
    setScreenShareStats((prev) => ({ ...prev, isPaused: false }));
    // Refresh first frame immediately
    setTimeout(() => {
      captureFrameAndSend();
    }, 100);
  };

  const switchScreenShare = async () => {
    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch (e) {}
      });
    }
    await startScreenSharing();
  };

  const handleResetScreenStats = () => {
    setScreenShareStats({
      sessionStartTime: isScreenSharing ? Date.now() : null,
      currentSessionSeconds: 0,
      totalHistoricalSeconds: 0,
      framesCaptured: 0,
      totalPayloadBytes: 0,
      currentResolution: { width: 0, height: 0 },
      targetResolution: { width: 0, height: 0 },
      recentFrameTimestamps: [],
      isPaused: isScreenSharingPaused,
      visionModeActive: screenVisionMode
    });
  };

  const [activeEmotion, setActiveEmotion] = useState<LohzEmotion>("idle");
  const [themeColor, setThemeColor] = useState<string>("charcoal");
  const [userCaption, setUserCaption] = useState<string>("");
  const [characterState, setCharacterState] = useState<"idle" | "thinking" | "talking">("idle");

  // Dynamic Ambiance state (auto sentiment mood theme matching)
  const [dynamicAmbianceEnabled, setDynamicAmbianceEnabled] = useState<boolean>(() => {
    const saved = localStorage.getItem("lohz_dynamic_ambiance");
    return saved !== null ? saved === "true" : true;
  });
  const [currentSentiment, setCurrentSentiment] = useState<SentimentAnalysisResult | null>(null);
  const [ambianceToast, setAmbianceToast] = useState<{ message: string; theme: string } | null>(null);

  // Voice Modulator state
  const [showVoiceModulator, setShowVoiceModulator] = useState<boolean>(false);

  // TextInput state
  const [isTextInputVisible, setIsTextInputVisible] = useState<boolean>(false);
  const [isTextProcessing, setIsTextProcessing] = useState<boolean>(false);

  // TranscriptionPanel state
  const [transcriptEntries, setTranscriptEntries] = useState<TranscriptEntry[]>([]);
  const [showTranscriptionPanel, setShowTranscriptionPanel] = useState<boolean>(false);
  const [conversationMode, setConversationMode] = useState<ConversationMode>("single_user");
  const [conversationState, setConversationState] = useState<ConversationParticipantState | null>(null);
  const [lastVoiceMemoryEligible, setLastVoiceMemoryEligible] = useState(true);

  // Cognitive Architecture refs
  const cognitiveLoopRef = useRef<CognitiveLoop | null>(null);
  const brainObservabilityRef = useRef<BrainObservability | null>(null);
  const memoryRetrievalRef = useRef<MemoryRetrieval | null>(null);
  const userIdRef = useRef<string>("default");

  // Keep userIdRef in sync with auth state
  useEffect(() => {
    userIdRef.current = user?.uid || "default";
    if (cognitiveLoopRef.current) {
      cognitiveLoopRef.current.setUserId(userIdRef.current);
    }
  }, [user]);

  // Sync proactive speech setting to cognitive loop
  useEffect(() => {
    if (cognitiveLoopRef.current) {
      cognitiveLoopRef.current.setProactiveEnabled(proactiveSpeechEnabled);
    }
  }, [proactiveSpeechEnabled]);

  // Initialize cognitive architecture
  useEffect(() => {
    // Phase 33: the historical browser-local CognitiveLoop is retained only
    // for compatibility/tests. It is not started in production because the
    // authenticated server CognitiveCore is the sole cognitive authority.
    cognitiveLoopRef.current = null;
    brainObservabilityRef.current = null;
    memoryRetrievalRef.current = null;
    return () => {
      cognitiveLoopRef.current = null;
      brainObservabilityRef.current = null;
      memoryRetrievalRef.current = null;
    };

    /* istanbul ignore next -- deprecated Phase 18 composition below */
    const brain = new BrainObservability();
    const memory = new MemoryRetrieval();
    brainObservabilityRef.current = brain;
    memoryRetrievalRef.current = memory;

    const loop = new CognitiveLoop({
      onSpeech: (text: string) => {
        // Cognitive loop wants LOHZ to speak — dispatch speech event
        console.log("[Cognitive] LOHZ wants to speak:", text);
        if (sessionRef.current && stateRef.current !== "disconnected") {
          // Use voice if connected, otherwise add to transcript
          addTranscriptEntry("assistant", text);
        } else {
          addTranscriptEntry("assistant", text);
        }
      },
      onToolUse: (tool: string, args: Record<string, unknown>) => {
        console.log("[Cognitive] Tool use:", tool, args);
      },
      onMemoryUpdate: (key: string, value: unknown) => {
        // Forward reflection memory updates to server for persistence
        console.log("[Cognitive] Memory update:", key);
        (async () => {
          try {
            const headers = await getAuthHeaders();
            const transaction = value as { action: string; id: string; layer: string; category: string; text: string; metadata: unknown };
            if (transaction.action === "ADD") {
              const resp = await fetch("/api/memories", {
                method: "POST",
                headers: { "Content-Type": "application/json", ...headers },
                body: JSON.stringify({ category: transaction.category, text: transaction.text }),
              });
              const saved = await resp.json();
              if (saved && saved.id) {
                setMemories((prev) => [...prev, saved]);
              }
            } else if (transaction.action === "UPDATE" && transaction.id) {
              const resp = await fetch(`/api/memories/${transaction.id}`, {
                method: "DELETE",
                headers,
              });
              if (resp.ok) {
                const addResp = await fetch("/api/memories", {
                  method: "POST",
                  headers: { "Content-Type": "application/json", ...headers },
                  body: JSON.stringify({ category: transaction.category, text: transaction.text }),
                });
                const saved = await addResp.json();
                if (saved && saved.id) {
                  setMemories((prev) => prev.filter(m => m.id !== transaction.id).concat(saved));
                }
              }
            }
          } catch (err) {
            console.error("[Cognitive] Failed to persist reflection memory update:", err);
          }
        })();
      },
      onStateChanged: (state) => {
        const snap = brain.capture(state, null, null);
        if (process.env.NODE_ENV === "development") {
          console.log("[Brain]", brain.toDebugLines(snap).map(d => `${d.label}: ${d.value}`).join(" | "));
        }
      },
      onTranscription: (role, text) => {
        addTranscriptEntry(role, text);
      },
      getExistingMemories: async () => {
        try {
          const headers = await getAuthHeaders();
          const resp = await fetch("/api/memories", { headers });
          const data = await resp.json();
          return Array.isArray(data) ? data : [];
        } catch {
          return [];
        }
      },
    }, userIdRef.current);

    cognitiveLoopRef.current = loop;

    return () => {
      cognitiveLoopRef.current = null;
      brainObservabilityRef.current = null;
      memoryRetrievalRef.current = null;
    };
  }, []);

  const addTranscriptEntry = useCallback((role: "user" | "assistant" | "system", text: string, turn?: SpeakerTurn) => {
    const entry: TranscriptEntry = {
      id: `te-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      role,
      text,
      timestamp: Date.now(),
      isFinal: true,
      ...(turn ? {
        speakerId: turn.speakerId,
        speakerRole: turn.speakerRole,
      } : {}),
    };
    setTranscriptEntries(prev => [...prev.slice(-199), entry]);
  }, []);

  // Initialize Atmosphere Engine on mount
  useEffect(() => {
    atmosphereEngineRef.current = new AtmosphereEngine(themeColor, (state) => {
      setIsAtmospherePlaying(state.isPlaying);
    });
    return () => {
      if (atmosphereEngineRef.current) {
        atmosphereEngineRef.current.pause();
      }
    };
  }, []);

  // Dynamic Ambiance: Automatically analyze user sentiment and adjust themeColor
  useEffect(() => {
    if (!userCaption || userCaption.trim().length < 3) return;
    const analysis = analyzeSentiment(userCaption);
    setCurrentSentiment(analysis);

    if (dynamicAmbianceEnabled && analysis.recommendedTheme !== themeColor) {
      handleThemeChange(analysis.recommendedTheme);
      setAmbianceToast({
        message: `Dynamic Ambiance: Shifted to ${analysis.recommendedTheme.toUpperCase()} • ${analysis.reason}`,
        theme: analysis.recommendedTheme,
      });
      const t = setTimeout(() => {
        setAmbianceToast(null);
      }, 3500);
      return () => clearTimeout(t);
    }
  }, [userCaption, dynamicAmbianceEnabled, themeColor]);

  // Global keyboard shortcuts (V: Voice Modulator, A: Dynamic Ambiance, T: Topics, M: Memory, S: Screen Share)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (["INPUT", "TEXTAREA"].includes((e.target as HTMLElement)?.tagName)) return;

      if (e.key.toLowerCase() === "v") {
        setShowVoiceModulator((prev) => !prev);
      } else if (e.key.toLowerCase() === "k") {
        setIsTextInputVisible((prev) => !prev);
      } else if (e.key.toLowerCase() === "x") {
        setShowTranscriptionPanel((prev) => !prev);
      } else if (e.key.toLowerCase() === "a") {
        setDynamicAmbianceEnabled((prev) => {
          const next = !prev;
          localStorage.setItem("lohz_dynamic_ambiance", next.toString());
          return next;
        });
      } else if (e.key.toLowerCase() === "t") {
        setShowGuide((prev) => !prev);
      } else if (e.key.toLowerCase() === "m") {
        setShowMemoryDashboard((prev) => !prev);
      } else if (e.key.toLowerCase() === "s") {
        if (isScreenSharing) {
          stopScreenSharing();
        } else {
          startScreenSharing();
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isScreenSharing]);

  const handleThemeChange = (newColor: string) => {
    setThemeColor(newColor);
    if (atmosphereEngineRef.current) {
      atmosphereEngineRef.current.setTheme(newColor);
    }
  };

  const handleToggleAtmosphere = () => {
    if (atmosphereEngineRef.current) {
      atmosphereEngineRef.current.toggle();
    }
  };

  const detectEmotionFromText = (text: string): LohzEmotion => {
    const lower = text.toLowerCase();
    if (lower.includes("haha") || lower.includes("lol") || lower.includes("funny") || lower.includes("joke") || lower.includes("hehe") || lower.includes("wink")) return "playful";
    if (lower.includes("happy") || lower.includes("harmony") || lower.includes("glad") || lower.includes("joy") || lower.includes("wonderful") || lower.includes("love") || lower.includes("smile")) return "happy";
    if (lower.includes("wow") || lower.includes("awesome") || lower.includes("excited") || lower.includes("amazing") || lower.includes("yay") || lower.includes("incredible") || lower.includes("hype")) return "excited";
    if (lower.includes("really?") || lower.includes("curious") || lower.includes("interest") || lower.includes("tell me more") || lower.includes("why") || lower.includes("how") || lower.includes("wonder")) return "curious";
    if (lower.includes("think") || lower.includes("calculat") || lower.includes("analyz") || lower.includes("hmmm") || lower.includes("process") || lower.includes("let me see") || lower.includes("conclude")) return "thinking";
    if (lower.includes("proud") || lower.includes("achieved") || lower.includes("expert") || lower.includes("skill") || lower.includes("confidence") || lower.includes("succeed")) return "proud";
    if (lower.includes("sad") || lower.includes("sorry") || lower.includes("unfortunate") || lower.includes("grief") || lower.includes("bad") || lower.includes("regret") || lower.includes("alas") || lower.includes("cry")) return "sad";
    if (lower.includes("shock") || lower.includes("surprise") || lower.includes("gasp") || lower.includes("unexpected") || lower.includes("seriously") || lower.includes("oh my")) return "surprised";
    if (lower.includes("blush") || lower.includes("shy") || lower.includes("embarrass") || lower.includes("nervous") || lower.includes("oops") || lower.includes("sorry about")) return "embarrassed";
    if (lower.includes("what?") || lower.includes("confus") || lower.includes("puzzled") || lower.includes("dont know") || lower.includes("not sure") || lower.includes("wait")) return "confused";
    return "idle";
  };
  const [modelCaption, setModelCaption] = useState<string>("");
  const [activeProjectorUrl, setActiveProjectorUrl] = useState<string | null>(null);
  const [showGuide, setShowGuide] = useState<boolean>(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  // LOHZ Autopilot system controller state
  const [browserTrigger, setBrowserTrigger] = useState<{
    type: string;
    args: any;
    id: string;
    callback: (res: any) => void;
  } | null>(null);

  // LOHZ recollections database core state
  const [memories, setMemories] = useState<Memory[]>([]);
  const [showMemoryDashboard, setShowMemoryDashboard] = useState<boolean>(false);

  const sessionRef = useRef<LohzAudioSession | null>(null);

  // Helper to get auth headers
  const getAuthHeaders = useCallback(async (): Promise<Record<string, string>> => {
    try {
      const token = await getIdToken();
      if (token) return { Authorization: `Bearer ${token}` };
      return import.meta.env.DEV ? { "X-LOHZ-Dev-Uid": "local-development" } : {};
    } catch {
      return import.meta.env.DEV ? { "X-LOHZ-Dev-Uid": "local-development" } : {};
    }
  }, [getIdToken]);

  // Fetch initial recollections from backend database
  useEffect(() => {
    const load = async () => {
      const headers = await getAuthHeaders();
      fetch("/api/memories", { headers })
        .then(res => res.json())
        .then(data => {
          if (Array.isArray(data)) {
            setMemories(data);
          }
        })
        .catch(err => console.error("Initial persistent recollections load failure:", err));
    };
    load();
  }, [getAuthHeaders]);

  const handleAddManualMemory = async (category: MemoryCategory, text: string) => {
    try {
      const headers = await getAuthHeaders();
      const resp = await fetch("/api/memories", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ category, text })
      });
      const saved = await resp.json();
      if (saved && saved.id) {
        setMemories((prev) => [...prev, saved]);
      }
    } catch (err) {
      console.error("Manual database recollect upload error:", err);
    }
  };

  const handleDeleteMemory = async (id: string) => {
    try {
      const headers = await getAuthHeaders();
      const resp = await fetch(`/api/memories/${id}`, {
        method: "DELETE",
        headers
      });
      const resObj = await resp.json();
      if (resObj && resObj.success) {
        setMemories((prev) => prev.filter(m => m.id !== id));
      }
    } catch (err) {
      console.error("Manual memory delete execution failed:", err);
    }
  };

  // Voice Memory Auto-Capture Hook: Listens for triggers like "LOHZ, remember this"
  const { lastCaptured, clearNotification } = useVoiceMemory({
    userCaption,
    memoryEligible: lastVoiceMemoryEligible,
    onAddMemory: handleAddManualMemory,
    debounceMs: 400
  });

  // Initialize the audio session handlers once on mount
  useEffect(() => {
    sessionRef.current = new LohzAudioSession({
      onStateChange: (newState) => {
        setState(newState);
        if (newState === "disconnected") {
          // Reset captions on disconnect
          setUserCaption("");
          setModelCaption("");
          setActiveEmotion("idle");
          setCharacterState("idle");
          setLastVoiceMemoryEligible(true);
        } else if (newState === "listening") {
          // Return to receptive resting state
          setActiveEmotion("idle");
          setCharacterState("idle");
        } else if (newState === "speaking") {
          setCharacterState("talking");
        }
      },
      onTranscription: (role, text, turn) => {
        const mappedRole = role === "model" ? "assistant" : role;

        // Add to transcription panel
        addTranscriptEntry(mappedRole, text, turn);

        // Dispatch to cognitive loop
        if (cognitiveLoopRef.current && (role !== "user" || !turn || turn.speakerRole === "primary_user")) {
          const event: CognitiveEvent = {
            type: "voice_transcript",
            payload: { text, role: mappedRole },
            timestamp: Date.now(),
            significance: "medium",
          };
          cognitiveLoopRef.current.dispatch(event);
        }

        if (role === "user" && (!turn || turn.speakerRole === "primary_user")) {
          setLastVoiceMemoryEligible(true);
          setUserCaption(text);
          setModelCaption("");
          setCharacterState("thinking");
        } else if (role === "user") {
          // Participant speech is visible session context, never primary-user memory/input state.
          setLastVoiceMemoryEligible(false);
          setUserCaption("");
          setCharacterState("idle");
        } else if (role === "model") {
          setIsTextProcessing(false);
          setModelCaption((prev) => {
            const next = prev + text;
            const newEmotion = detectEmotionFromText(next);
            setActiveEmotion(newEmotion);
            return next;
          });
          setUserCaption("");
        }
      },
      onConversationState: setConversationState,
      onToolCall: (name, args, callback) => {
        console.log(`[App] Tool call triggered: ${name}`, args);
        
        const browserTools = [
          "browserOpen",
          "browserSearch",
          "browserClick",
          "browserMediaControl",
          "browserScroll",
          "browserType",
          "browserGoBack",
          "browserTabAction",
          "openWebsite"
        ];

        if (browserTools.includes(name)) {
          // Bring up the Holographic Browser Controller if it is not active
          if (!activeProjectorUrl) {
            let startingUrl = "https://youtube.com";
            if ((name === "browserOpen" || name === "openWebsite") && args.url) {
              startingUrl = args.url;
            }
            setActiveProjectorUrl(startingUrl);
          }

          // Map instructions directly onto Browser Agent
          setBrowserTrigger({
            type: name === "openWebsite" ? "browserOpen" : name,
            args,
            id: Math.random().toString(),
            callback: (res) => {
              callback(res);
              setBrowserTrigger(null);
            }
          });
        } else if (name === "changeBackground") {
          const colorName = args.color?.toLowerCase();
          const validColors = ["violet", "crimson", "emerald", "celestial", "gold", "rose", "charcoal"];
          
          if (colorName && validColors.includes(colorName)) {
            handleThemeChange(colorName);
            callback({ result: `Successfully shifted aesthetic atmosphere to ${colorName}.` });
          } else {
            callback({ error: `Unsupported color '${colorName}'. Supported themes are: ${validColors.join(", ")}` });
          }
        } else {
          callback({ error: `Tool ${name} is not implemented.` });
        }
      },
      onError: (err) => {
        setErrorText(err);
      },
      onMemorySync: (updatedMemories) => {
        console.log("[App] WebSocket memories sync triggered:", updatedMemories);
        if (Array.isArray(updatedMemories)) {
          setMemories(updatedMemories);
        }
      },
      onAgentStatus: (status) => {
        // Update agent connection status in UI
        setAgentStatus(status);
      }
    });

    return () => {
      if (sessionRef.current) {
        sessionRef.current.disconnect();
      }
    };
  }, []);

  // TextInput: send text message into cognitive architecture
  const handleTextSend = useCallback(async (text: string) => {
    if (!text.trim()) return;
    setLastVoiceMemoryEligible(true);
    setIsTextProcessing(true);
    addTranscriptEntry("user", text);
    setUserCaption(text);
    setModelCaption("");
    setCharacterState("thinking");

    if (cognitiveLoopRef.current) {
      const event: CognitiveEvent = {
        type: "user_message",
        payload: { text, role: "user" },
        timestamp: Date.now(),
        significance: "high",
      };
      cognitiveLoopRef.current.dispatch(event);
    }

    try {
      const headers = await getAuthHeaders();
      const response = await fetch("/api/route", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ text }),
      });
      let result = await response.json();
      if (!response.ok) throw new Error(result?.error || `Cognitive request failed (${response.status})`);
      if (Array.isArray(result.lifecycle) && result.lifecycle.includes("AWAITING_CONFIRMATION") && result.requestId) {
        const approved = window.confirm("This request requires confirmation before any tool runs. Continue?");
        if (approved) {
          const confirmation = await fetch(`/api/executions/${encodeURIComponent(result.requestId)}/confirm`, {
            method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: "{}",
          });
          const confirmed = await confirmation.json();
          if (!confirmation.ok) throw new Error(confirmed?.error || "Confirmation could not be resumed safely.");
          result = { ...result, success: confirmed.success, response: confirmed.summary };
        } else {
          result = { ...result, response: "Confirmation was not granted. Nothing was executed." };
        }
      }
      const reply = typeof result.response === "string" && result.response.trim()
        ? result.response
        : "The cognitive pipeline completed without a textual response.";
      addTranscriptEntry("assistant", reply);
      setModelCaption(reply);
      setUserCaption("");
      setActiveEmotion(detectEmotionFromText(reply));
      setCharacterState("idle");
    } catch (error: any) {
      const message = error?.message || "The authenticated cognitive service is unavailable.";
      setErrorText(message);
      addTranscriptEntry("assistant", `Unable to process that request: ${message}`);
      setCharacterState("idle");
    } finally {
      setIsTextProcessing(false);
    }
  }, [addTranscriptEntry, getAuthHeaders]);

  const handleToggleTextInput = useCallback(() => {
    setIsTextInputVisible(v => !v);
  }, []);

  const handleToggleTranscription = useCallback(() => {
    setShowTranscriptionPanel(v => !v);
  }, []);

  const handleClearTranscripts = useCallback(() => {
    setTranscriptEntries([]);
  }, []);

  const isThinking = characterState === "thinking";

  const handleToggleConnection = async () => {
    setErrorText(null);
    if (!sessionRef.current) return;

    if (state === "disconnected") {
      const token = await getIdToken();
      await sessionRef.current.connect(token || undefined);
    } else {
      sessionRef.current.disconnect();
    }
  };

  // Maps theme colors to CSS ambient light spots
  const getAmbientStyles = () => {
    switch (themeColor) {
      case "violet":
        return "from-purple-950/40 via-violet-950/20 to-slate-950";
      case "crimson":
        return "from-red-950/40 via-orange-950/20 to-slate-950";
      case "emerald":
        return "from-emerald-950/40 via-teal-950/20 to-slate-950";
      case "celestial":
        return "from-sky-950/45 via-indigo-950/25 to-slate-950";
      case "gold":
        return "from-amber-950/30 via-yellow-950/15 to-slate-950";
      case "rose":
        return "from-rose-950/40 via-pink-950/20 to-slate-950";
      case "charcoal":
      default:
        return "from-slate-900/50 via-slate-950/30 to-slate-950";
    }
  };

  const getThemeTextGlow = () => {
    switch (themeColor) {
      case "violet": return "text-purple-400 drop-shadow-[0_0_12px_rgba(168,85,247,0.5)]";
      case "crimson": return "text-rose-400 drop-shadow-[0_0_12px_rgba(244,63,94,0.5)]";
      case "emerald": return "text-emerald-400 drop-shadow-[0_0_12px_rgba(16,185,129,0.5)]";
      case "celestial": return "text-sky-400 drop-shadow-[0_0_12px_rgba(14,165,233,0.5)]";
      case "gold": return "text-amber-400 drop-shadow-[0_0_12px_rgba(245,158,11,0.5)]";
      case "rose": return "text-pink-400 drop-shadow-[0_0_12px_rgba(244,63,94,0.5)]";
      case "charcoal":
      default:
        return "text-indigo-400 drop-shadow-[0_0_12px_rgba(99,102,241,0.5)]";
    }
  };

  const getOrbRingColor = () => {
    switch (state) {
      case "listening": return "border-indigo-500/50 shadow-[0_0_30px_rgba(99,102,241,0.3)] bg-indigo-500/10";
      case "speaking": return "border-purple-500/70 shadow-[0_0_40px_rgba(168,85,247,0.4)] bg-purple-500/10";
      case "connecting": return "border-amber-500/50 animate-pulse bg-amber-500/10";
      case "disconnected":
      default:
        return "border-white/10 hover:border-indigo-500/30 bg-white/5";
    }
  };

  return (
    <div
      id="lohz-holographic-desktop"
      className={`relative w-full h-screen overflow-hidden bg-[#020205] text-white ${getAmbientStyles()} theme-transition flex flex-col justify-between p-6 sm:p-10 select-none`}
    >
      {/* Ambient Background Gradients matching Frosted Glass theme */}
      <div className="absolute top-[-10%] left-[-10%] w-[500px] h-[500px] bg-purple-900/15 rounded-full blur-[120px] pointer-events-none" />
      <div className="absolute bottom-[-10%] right-[-10%] w-[600px] h-[600px] bg-cyan-900/15 rounded-full blur-[150px] pointer-events-none" />
      <div className="absolute top-[20%] right-[10%] w-[300px] h-[300px] bg-indigo-800/10 rounded-full blur-[100px] pointer-events-none" />

      {/* Decorative grid pattern background */}
      <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.012)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.012)_1px,transparent_1px)] bg-[size:32px_32px] pointer-events-none opacity-40" />

      {/* FULL VIEWPORT HOLOGRAPHIC STAGE: LOHZ materializes across the entire screen */}
      <div className="absolute inset-0 z-0 pointer-events-none select-none">
        <LohzCoreVisualizer
          session={sessionRef.current}
          state={state}
          themeColor={themeColor}
          activeEmotion={activeEmotion}
          characterState={characterState}
        />
      </div>

      {/* HEADER SECTION - Minimalist typography & interactive controls */}
      <header className="relative z-30 flex items-center justify-between w-full max-w-5xl mx-auto select-none">
        <div className="flex items-center gap-2">
          <img src="/assets/branding/lohz-mark.svg" alt="" aria-hidden="true" className="size-7" />
          <span className="text-sm font-semibold tracking-[0.4em] text-white/50 uppercase font-sans">
            LOHZ
          </span>
          <div className={`w-1.5 h-1.5 rounded-full ${
            state === "listening" || state === "speaking" 
              ? "bg-cyan-400" 
              : "bg-white/10"
          }`} />
        </div>

        <div className="flex items-center gap-3 sm:gap-4 flex-wrap justify-end">
          {/* Atmosphere Ambient Lo-Fi Soundscape Controller */}
          <AtmosphereController
            engine={atmosphereEngineRef.current}
            isPlaying={isAtmospherePlaying}
            onToggle={handleToggleAtmosphere}
            themeColor={themeColor}
            onThemeSelect={handleThemeChange}
          />

          {/* Dynamic Ambiance Sentiment Trigger */}
          <Tooltip 
            content={
              dynamicAmbianceEnabled 
                ? `Dynamic Ambiance: Active (Auto-shifts theme based on speech sentiment: ${currentSentiment?.label || "neutral"}${currentSentiment ? ` / score ${currentSentiment.score > 0 ? "+" : ""}${currentSentiment.score}` : ""}). Click to toggle.`
                : "Dynamic Ambiance: Off. Click to enable auto theme shifts matching speech sentiment."
            } 
            shortcut="A" 
            side="bottom"
          >
            <button
              onClick={() => {
                setDynamicAmbianceEnabled((prev) => {
                  const next = !prev;
                  localStorage.setItem("lohz_dynamic_ambiance", next.toString());
                  return next;
                });
              }}
              className={`flex items-center gap-1.5 transition text-xs font-mono tracking-widest cursor-pointer px-2.5 py-1 rounded-full border ${
                dynamicAmbianceEnabled
                  ? "bg-amber-500/10 border-amber-400/30 text-amber-300 shadow-[0_0_15px_rgba(245,158,11,0.2)]"
                  : "opacity-40 hover:opacity-100 text-white border-transparent"
              }`}
              aria-label="Toggle Dynamic Ambiance"
            >
              <Sparkles size={13} className={dynamicAmbianceEnabled ? "text-amber-300 animate-pulse" : ""} />
              <span className="hidden sm:inline">
                {dynamicAmbianceEnabled && currentSentiment && currentSentiment.label !== "neutral"
                  ? `AMBIANCE (${currentSentiment.label.toUpperCase()})`
                  : "AMBIANCE"}
              </span>
            </button>
          </Tooltip>

          {/* Voice Modulator Slider Floating Panel Trigger */}
          <Tooltip
            content={conversationMode === "multi_person"
              ? "Group conversation is on. Untagged voice is treated as an unknown participant, not the account owner."
              : "Switch between one-person and privacy-safe group conversation attribution."}
            side="bottom"
          >
            <button
              type="button"
              aria-pressed={conversationMode === "multi_person"}
              aria-label={conversationMode === "multi_person" ? "Disable group conversation" : "Enable group conversation"}
              onClick={() => {
                const next: ConversationMode = conversationMode === "single_user" ? "multi_person" : "single_user";
                setConversationMode(next);
                sessionRef.current?.setConversationMode(next);
              }}
              className={`flex items-center gap-1.5 transition text-xs font-mono tracking-widest cursor-pointer px-2.5 py-1 rounded-full border ${
                conversationMode === "multi_person"
                  ? "bg-cyan-500/20 border-cyan-400/60 text-cyan-100 shadow-[0_0_15px_rgba(34,211,238,0.2)]"
                  : "opacity-40 hover:opacity-100 text-white border-transparent"
              }`}
            >
              <Users size={13} aria-hidden="true" />
              <span className="hidden sm:inline">
                {conversationMode === "multi_person"
                  ? (conversationState && conversationState.participantCount > 1
                    ? `${conversationState.participantCount} PEOPLE`
                    : "GROUP")
                  : "1 PERSON"}
              </span>
            </button>
          </Tooltip>

          {/* Voice Modulator Slider Floating Panel Trigger */}
          <Tooltip content="Modulate LOHZ vocal pitch & tempo dynamically in real-time" shortcut="V" side="bottom">
            <button
              onClick={() => setShowVoiceModulator(!showVoiceModulator)}
              className={`flex items-center gap-1.5 transition text-xs font-mono tracking-widest cursor-pointer px-2.5 py-1 rounded-full border ${
                showVoiceModulator
                  ? "bg-cyan-500/20 border-cyan-400 text-cyan-200 shadow-[0_0_15px_rgba(34,211,238,0.25)]"
                  : "opacity-40 hover:opacity-100 text-white border-transparent"
              }`}
              aria-label="Toggle Voice Modulator"
            >
              <Sliders size={13} />
              <span className="hidden sm:inline">VOICE TUNER</span>
            </button>
          </Tooltip>

          {/* Topics & Guide Modal Trigger */}
          <Tooltip content="Explore spoken voice triggers, tools & core capabilities" shortcut="T" side="bottom">
            <button
              onClick={() => setShowGuide(!showGuide)}
              className="flex items-center gap-1 opacity-40 hover:opacity-100 text-white transition text-xs font-mono tracking-widest cursor-pointer"
              aria-label="Topics and Guidance"
            >
              <Compass size={14} />
              <span className="hidden sm:inline">TOPICS</span>
            </button>
          </Tooltip>
          
          {/* Recollections Database Trigger */}
          <Tooltip content="View and manage LOHZ's persistent memory bank & facts" shortcut="M" side="bottom">
            <button 
              onClick={() => setShowMemoryDashboard(!showMemoryDashboard)}
              className="flex items-center gap-1 opacity-40 hover:opacity-100 text-white transition text-xs font-mono tracking-widest cursor-pointer"
              aria-label="Recollections Database"
            >
              <Brain size={14} />
              <span className="hidden sm:inline">RECALLS</span>
            </button>
          </Tooltip>

          {/* Text Input toggle */}
          <Tooltip content="Toggle floating text message input" shortcut="K" side="bottom">
            <button
              onClick={handleToggleTextInput}
              className={`flex items-center gap-1.5 transition text-xs font-mono tracking-widest cursor-pointer px-2.5 py-1 rounded-full border ${
                isTextInputVisible
                  ? "bg-violet-500/15 border-violet-400/40 text-violet-300 shadow-[0_0_15px_rgba(168,85,247,0.2)]"
                  : "opacity-40 hover:opacity-100 text-white border-transparent"
              }`}
              aria-label="Toggle Text Input"
            >
              <Keyboard size={13} />
              <span className="hidden sm:inline">TYPE</span>
            </button>
          </Tooltip>

          {/* Transcription Panel toggle */}
          <Tooltip content="Toggle live transcription panel" shortcut="X" side="bottom">
            <button
              onClick={handleToggleTranscription}
              className={`flex items-center gap-1.5 transition text-xs font-mono tracking-widest cursor-pointer px-2.5 py-1 rounded-full border ${
                showTranscriptionPanel
                  ? "bg-cyan-500/15 border-cyan-400/40 text-cyan-300 shadow-[0_0_15px_rgba(34,211,238,0.2)]"
                  : "opacity-40 hover:opacity-100 text-white border-transparent"
              }`}
              aria-label="Toggle Transcription Panel"
            >
              <MessageSquare size={13} />
              <span className="hidden sm:inline">LIVE TEXT</span>
            </button>
          </Tooltip>

          {/* Real-time screen sharing toggler button */}
          <Tooltip content={isScreenSharing ? "Currently sharing screen with Gemini Vision. Click to stop." : "Share your screen or browser window with LOHZ's real-time multimodal vision"} shortcut="S" side="bottom">
            <button 
              onClick={isScreenSharing ? stopScreenSharing : startScreenSharing}
              className={`flex items-center gap-1.5 transition text-xs font-mono tracking-widest cursor-pointer ${
                isScreenSharing 
                  ? "text-cyan-400 opacity-100 font-semibold" 
                  : "opacity-40 hover:opacity-100 text-white"
              }`}
              aria-label="Toggle Screen Sharing"
            >
              <Monitor size={14} className={isScreenSharing && !isScreenSharingPaused ? "animate-pulse text-cyan-400" : ""} />
              <span>{isScreenSharing ? "SHARING" : "SHARE SCREEN"}</span>
            </button>
          </Tooltip>

          {/* User Account Button */}
          <Tooltip content={user ? `Signed in as ${user.displayName || user.email}` : "Sign in to LOHZ"} side="bottom">
            <button
              onClick={() => { setInitialSettingsTab("account"); setIsSettingsOpen(true); }}
              className={`flex items-center gap-1.5 transition text-xs font-mono tracking-widest cursor-pointer px-2.5 py-1 rounded-full border ${
                user
                  ? "bg-indigo-500/15 border-indigo-400/40 text-indigo-300"
                  : "opacity-40 hover:opacity-100 text-white border-transparent"
              }`}
              aria-label="Account"
            >
              {user?.photoURL ? (
                <img src={user.photoURL} alt="" className="w-4 h-4 rounded-full border border-white/20" />
              ) : (
                <User size={13} />
              )}
              <span className="hidden sm:inline">{user ? (user.displayName?.split(" ")[0] || "Account") : "SIGN IN"}</span>
            </button>
          </Tooltip>
        </div>
      </header>

      {/* CORE AVATAR AND VISUALS */}
      <main className="relative z-10 flex-1 w-full max-w-4xl mx-auto flex flex-col items-center justify-between py-6">
        
        {/* Holographic Projection Screen Widget (if website opened) */}
        <AnimatePresence>
          {activeProjectorUrl && (
            <div className="absolute inset-x-0 top-0 z-30 flex justify-center p-2">
              <motion.div
                initial={{ opacity: 0, y: -20, scale: 0.95 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -20, scale: 0.95 }}
                className="flex items-center justify-between gap-4 p-3.5 rounded-2xl border border-indigo-500/20 bg-indigo-950/45 backdrop-blur-xl shadow-lg w-full max-w-md"
              >
                <div className="flex items-center gap-3 overflow-hidden text-left">
                  <div className="p-2 ml-1 rounded-xl bg-indigo-500/20 text-indigo-300">
                    <Globe size={18} />
                  </div>
                  <div className="overflow-hidden">
                    <h4 className="text-xs font-bold font-mono tracking-wide text-indigo-200 uppercase">Holographic Projection Broadcast</h4>
                    <p className="text-xs text-indigo-400 truncate max-w-[200px]">{activeProjectorUrl}</p>
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <Tooltip content="Focus and maximize browser projection frame" side="left">
                    <button
                      onClick={() => setActiveProjectorUrl(activeProjectorUrl)}
                      className="p-2 rounded-xl bg-indigo-500 text-white hover:bg-indigo-400 transition cursor-pointer"
                      aria-label="View Projection Frame"
                    >
                      <Maximize2 size={14} />
                    </button>
                  </Tooltip>

                  <Tooltip content="Close holographic projector" side="left">
                    <button
                      onClick={() => setActiveProjectorUrl(null)}
                      className="p-2 rounded-xl hover:bg-white/5 text-slate-400 hover:text-white transition cursor-pointer"
                      aria-label="Close Projector"
                    >
                      <X size={14} />
                    </button>
                  </Tooltip>
                </div>
              </motion.div>
            </div>
          )}
        </AnimatePresence>

        {/* Space Spacer to avoid head area */}
        <div className="h-10 sm:h-20" />

        {/* Cinematic dialogue layer overlay - Smooth, delicate text transitions with soft focus blur */}
        <div id="cinematic-subtitles" className="w-full max-w-3xl flex flex-col items-center justify-center text-center px-6 relative z-25 mt-auto mb-6 pointer-events-none min-h-[6rem]">
          <AnimatePresence mode="wait">
            {(() => {
              const textType = modelCaption 
                ? "model" 
                : userCaption 
                  ? "user" 
                  : "status";

              const activeText = modelCaption 
                ? modelCaption 
                : userCaption 
                  ? userCaption 
                  : state === "listening" 
                    ? "I am listening. Speak freely..." 
                    : state === "connecting" 
                      ? "Materializing presence links..." 
                      : "Connect memory core to awaken my voice.";

              return (
                <motion.div
                  key={textType}
                  initial={{ opacity: 0, y: 15, filter: "blur(6px)" }}
                  animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                  exit={{ opacity: 0, y: -15, filter: "blur(6px)" }}
                  transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
                  className="flex flex-col items-center justify-center w-full"
                >
                  {textType === "model" && (
                    <h2 className="text-xl sm:text-2xl font-light text-white leading-relaxed tracking-wide font-display max-w-2xl drop-shadow-[0_2px_20px_rgba(0,0,0,0.9)]">
                      {activeText}
                    </h2>
                  )}

                  {textType === "user" && (
                    <p className="text-cyan-300 font-mono text-sm sm:text-base tracking-wider flex items-center justify-center gap-2 drop-shadow-[0_1px_10px_rgba(0,0,0,0.85)] font-medium">
                      <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />
                      <span>&ldquo;{activeText}&rdquo;</span>
                    </p>
                  )}

                  {textType === "status" && (
                    <span className="text-xs sm:text-sm uppercase tracking-[0.3em] font-medium text-white/30 font-sans tracking-widest drop-shadow-[0_1px_4px_rgba(0, 0, 0, 0.5)]">
                      {activeText}
                    </span>
                  )}
                </motion.div>
              );
            })()}
          </AnimatePresence>
        </div>

        {/* Interactive suggestions prompt guide */}
        <AnimatePresence>
          {showGuide && (
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 10 }}
              className="mt-6 p-5 rounded-2xl border border-white/10 bg-slate-900/85 backdrop-blur-2xl max-w-md text-left w-full absolute z-40 shadow-2xl"
            >
              <div className="flex items-center justify-between mb-3 text-white">
                <div className="flex items-center gap-1.5 font-display text-sm font-bold tracking-wide">
                  <Compass size={16} className="text-indigo-400" />
                  <span>PLAYFUL CORE SUGGESTIONS</span>
                </div>
                <Tooltip content="Close Guide" side="left">
                  <button 
                    onClick={() => setShowGuide(false)}
                    className="text-slate-400 hover:text-white transition cursor-pointer p-1"
                    aria-label="Close Guide"
                  >
                    <X size={14} />
                  </button>
                </Tooltip>
              </div>
              <p className="text-xs text-slate-400 mb-4 font-mono leading-relaxed">
                LOHZ is equipped with dynamic visual modules and standard text browser projectors. Here are clever triggers to try speaking aloud:
              </p>
              <div className="space-y-2 text-xs font-serif italic text-indigo-300">
                <Tooltip content="Click to test setting atmosphere to crimson theme" side="top">
                  <div 
                    onClick={() => handleThemeChange("crimson")}
                    className="p-2.5 rounded-xl bg-white/5 border border-white/5 hover:bg-white/10 transition cursor-pointer font-sans normal-case text-slate-200"
                  >
                    ⚡ &quot;LOHZ, change atmosphere of your core to crimson&quot; <span className="text-[10px] font-mono text-indigo-400 block mt-0.5 font-medium">Shifts theme color & soundscape</span>
                  </div>
                </Tooltip>

                <Tooltip content="Say this aloud during voice session to open YouTube" side="top">
                  <div className="p-2.5 rounded-xl bg-white/5 border border-white/5 hover:bg-white/10 transition cursor-pointer font-sans normal-case text-slate-200">
                    ⚡ &quot;Open youtube.com on my screen please&quot; <span className="text-[10px] font-mono text-indigo-400 block mt-0.5 font-medium">Invokes browser projector panel</span>
                  </div>
                </Tooltip>

                <Tooltip content="Say this aloud to automatically save into LOHZ's persistent memory bank" side="top">
                  <div className="p-2.5 rounded-xl bg-white/5 border border-white/5 hover:bg-white/10 transition cursor-pointer font-sans normal-case text-slate-200">
                    ⚡ &quot;LOHZ, remember this: my favorite music genre is Synthwave&quot; <span className="text-[10px] font-mono text-cyan-400 block mt-0.5 font-medium">Auto-captures into memory database</span>
                  </div>
                </Tooltip>

                <Tooltip content="Click to test setting atmosphere to gold theme" side="top">
                  <div 
                    onClick={() => handleThemeChange("gold")}
                    className="p-2.5 rounded-xl bg-white/5 border border-white/5 hover:bg-white/10 transition cursor-pointer font-sans normal-case text-slate-200"
                  >
                    ⚡ &quot;Tell me a witty joke and change background to gold&quot; <span className="text-[10px] font-mono text-indigo-400 block mt-0.5 font-medium">Combines tools & voice</span>
                  </div>
                </Tooltip>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Holographic Voice Auto-Memory Toast Notification */}
        <AnimatePresence>
          {lastCaptured && (
            <motion.div
              initial={{ opacity: 0, y: 16, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -16, scale: 0.95 }}
              className="fixed bottom-28 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3 px-4 py-2.5 rounded-2xl bg-[#070e1c]/90 border border-cyan-400/40 shadow-[0_0_35px_rgba(34,211,238,0.35)] backdrop-blur-xl pointer-events-auto text-xs font-mono text-cyan-200 max-w-[90vw] sm:max-w-lg"
            >
              <div className="p-1.5 rounded-lg bg-cyan-500/20 border border-cyan-400/30 text-cyan-300 shrink-0">
                <Brain size={16} className="animate-pulse" />
              </div>
              <div className="flex flex-col min-w-0 text-left">
                <div className="flex items-center gap-1.5">
                  <span className="font-bold text-cyan-300 uppercase text-[10px] tracking-wider font-mono">RECOLLECTION SAVED</span>
                  <span className="text-[9px] px-1.5 py-0.2 rounded bg-cyan-400/10 text-cyan-300/80 uppercase font-mono">[{lastCaptured.category}]</span>
                </div>
                <span className="truncate text-white font-sans text-xs mt-0.5">&ldquo;{lastCaptured.text}&rdquo;</span>
              </div>
              <button 
                onClick={clearNotification}
                className="ml-auto p-1 rounded-lg hover:bg-white/10 text-slate-400 hover:text-white transition cursor-pointer shrink-0"
                aria-label="Dismiss Notification"
              >
                <X size={14} />
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Global Error Banner */}
        <AnimatePresence>
          {errorText && (
            <motion.div
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 15 }}
              className="mt-6 flex items-start gap-3 p-4 rounded-2xl border border-rose-500/20 bg-rose-950/40 backdrop-blur-xl max-w-md w-full text-left"
            >
              <CircleAlert className="text-rose-400 shrink-0 mt-0.5" size={18} />
              <div>
                <h4 className="text-xs font-bold uppercase tracking-widest text-rose-300 font-mono">Core Error Protocol</h4>
                <p className="text-xs text-rose-200 mt-1 leading-relaxed">{errorText}</p>
                <button
                  onClick={() => setErrorText(null)}
                  className="mt-2 text-[10px] font-bold text-rose-400 underline font-mono uppercase cursor-pointer"
                >
                  Dismiss Code
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

      </main>

      {/* FOOTER INTERFACE WITH WAVEFORM AND CONTROLS */}
      <footer className="relative z-10 w-full max-w-2xl mx-auto flex flex-col items-center gap-5 mt-auto">
        
        {/* Dynamic Minimalist Waveform Visualizer */}
        <div className="flex items-center justify-center gap-1 h-8 w-44">
          {[12, 28, 16, 32, 20, 8].map((baseHeight, idx) => {
            let heightFactor = 0.35;
            if (state === "speaking") {
              heightFactor = 0.35 + Math.sin(Date.now() * 0.02 + idx * 0.9) * 0.65;
            } else if (state === "listening") {
              heightFactor = 0.2 + Math.sin(Date.now() * 0.01 + idx * 0.5) * 0.4;
            } else {
              heightFactor = idx % 2 === 0 ? 0.25 : 0.12;
            }
            const calculatedHeight = Math.max(3, baseHeight * heightFactor);

            return (
              <div
                key={idx}
                className={`w-0.5 rounded-full transition-all duration-300 ${
                  state === "speaking" ? "bg-purple-400" : state === "listening" ? "bg-cyan-400" : "bg-white/10"
                }`}
                style={{ height: `${calculatedHeight}px` }}
              />
            );
          })}
        </div>

        {/* Glossy Beautiful Primary Connector Core Node with Biometric Heartbeat Glow */}
        <div className="flex items-center justify-center relative mb-4">
          {/* Subtle Outward-Expanding Biometric Heartbeat Glow Waves */}
          {(state === "listening" || state === "speaking") && (
            <>
              {/* Outer wave 1 */}
              <div 
                className={`absolute inset-0 rounded-full pointer-events-none ${
                  state === "speaking" 
                    ? "animate-biometric-heartbeat-fast border border-purple-400/50 bg-purple-500/10" 
                    : "animate-biometric-heartbeat border border-cyan-400/50 bg-cyan-500/10"
                }`} 
              />
              {/* Delayed outer wave 2 */}
              <div 
                className={`absolute inset-0 rounded-full pointer-events-none ${
                  state === "speaking" 
                    ? "animate-biometric-heartbeat-fast border border-fuchsia-400/40 bg-fuchsia-500/5" 
                    : "animate-biometric-heartbeat-delayed border border-cyan-300/30 bg-cyan-400/5"
                }`} 
                style={{ animationDelay: state === "speaking" ? "0.45s" : "0.75s" }}
              />
              {/* Diffuse biometric ambient halo */}
              <div 
                className={`absolute -inset-2 rounded-full blur-lg opacity-70 pointer-events-none transition-all duration-700 ${
                  state === "speaking" ? "bg-purple-500/35" : "bg-cyan-400/25"
                }`} 
              />
            </>
          )}

          <Tooltip 
            content={
              state === "disconnected"
                ? "Awaken LOHZ Voice Core (Initiate live microphone & voice session)"
                : state === "listening"
                ? "Session Active & Listening: Click to sleep voice core"
                : state === "speaking"
                ? "LOHZ Speaking: Click to disconnect"
                : "Establishing bidirectional live session..."
            }
            side="top"
          >
            <button 
              onClick={handleToggleConnection}
              className={`relative z-10 w-20 h-20 rounded-full flex items-center justify-center transition-all duration-500 cursor-pointer ${
                state === "disconnected"
                  ? "bg-white/10 hover:bg-white/15 border border-white/15 text-white shadow-[0_0_20px_rgba(255,255,255,0.02)] hover:scale-105 active:scale-95"
                  : state === "listening"
                  ? "bg-cyan-500/15 hover:bg-cyan-500/25 border border-cyan-400/80 text-cyan-200 shadow-[0_0_35px_rgba(34,211,238,0.35)] scale-105"
                  : state === "speaking"
                  ? "bg-purple-500/90 hover:bg-purple-600 border border-purple-400/95 text-white shadow-[0_0_40px_rgba(168,85,247,0.5)] scale-105"
                  : "bg-amber-600 border border-amber-300 text-white animate-spin"
              }`}
              aria-label={state === "disconnected" ? "Awake Voice Core" : "Sleep Voice Core"}
            >
              {state === "disconnected" ? (
                <Power className="opacity-80" size={24} />
              ) : state === "connecting" ? (
                <div className="w-6 h-6 border-2 border-white border-t-transparent rounded-full animate-spin" />
              ) : state === "listening" ? (
                <Mic size={24} className="text-cyan-200" />
              ) : (
                <Volume2 size={24} className="text-white" />
              )}
            </button>
          </Tooltip>

          {/* Windows Agent Status Indicator */}
          {agentStatus && (
            <Tooltip content={`Windows Agent: ${agentStatus.online ? 'Online' : agentStatus.connecting ? 'Connecting' : 'Offline'}`} side="left">
              <button 
                onClick={() => {
                  setInitialSettingsTab("agent");
                  setIsSettingsOpen(true);
                }}
                aria-label="Open Windows Agent settings"
                className={`absolute left-[-60px] p-2 rounded-full hover:bg-white/5 text-slate-400 hover:text-white transition duration-150 cursor-pointer ${
                  agentStatus.online ? 'bg-emerald-500/20' : 
                  agentStatus.connecting ? 'bg-amber-500/20 animate-pulse' : 
                  'bg-crimson-500/20'
                }`}
              >
                {agentStatus.online ? (
                  <Monitor className="size-5" />
                ) : agentStatus.connecting ? (
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                ) : (
                  <CircleAlert className="size-5" />
                )}
              </button>
            </Tooltip>
          )}

          {/* Quiet Reset Projection Anchor */}
          {(activeProjectorUrl || errorText) && (
            <Tooltip content="Clear Active Projections & Errors" side="right">
              <button 
                onClick={() => {
                  if (activeProjectorUrl) setActiveProjectorUrl(null);
                  setErrorText(null);
                }}
                className="absolute right-[-60px] p-2 rounded-full hover:bg-white/5 text-slate-400 hover:text-white transition duration-150 cursor-pointer"
                aria-label="Reset Broadcasts"
              >
                <X size={16} />
              </button>
            </Tooltip>
          )}
        </div>

      {/* Settings button */}
      <Tooltip content="Open Settings" side="left">
        <button 
          onClick={() => setIsSettingsOpen(true)}
          className="absolute left-[-60px] p-2 rounded-full hover:bg-white/5 text-slate-400 hover:text-white transition duration-150 cursor-pointer"
        >
          <SettingsIcon className="size-5" />
        </button>
      </Tooltip>
</footer>

      {/* TextInput - Floating transparent glass message input */}
      <TextInput
        isVisible={isTextInputVisible}
        onSend={handleTextSend}
        onToggleVoice={handleToggleConnection}
        isVoiceActive={state !== "disconnected"}
        isProcessing={isTextProcessing}
        isThinking={isThinking}
        themeColor={themeColor}
      />

      {/* TranscriptionPanel - Live voice transcription display */}
      <TranscriptionPanel
        isOpen={showTranscriptionPanel}
        onClose={() => setShowTranscriptionPanel(false)}
        entries={transcriptEntries}
        onClear={handleClearTranscripts}
        isLive={state !== "disconnected"}
        isThinking={isThinking}
        themeColor={themeColor}
      />

      {/* Settings Modal */}
      <Settings isOpen={isSettingsOpen} onClose={() => setIsSettingsOpen(false)} agentStatus={agentStatus} initialTab={initialSettingsTab} proactiveSpeechEnabled={proactiveSpeechEnabled} onProactiveSpeechChange={setProactiveSpeechEnabled} />

      {/* Holographic Website frame projections */}
      <AnimatePresence>
        {activeProjectorUrl && (
          <BrowserAgent
            url={activeProjectorUrl}
            onClose={() => {
              setActiveProjectorUrl(null);
              setBrowserTrigger(null);
            }}
            actionTrigger={browserTrigger}
          />
        )}
      </AnimatePresence>

      {/* Dynamic Floating Glassmorphic Screen Sharing Control Hub */}
      <AnimatePresence>
        {isScreenSharing && (
          <motion.div
            initial={{ opacity: 0, scale: 0.85, x: 50 }}
            animate={{ opacity: 1, scale: 1, x: 0 }}
            exit={{ opacity: 0, scale: 0.85, x: 50 }}
            className={`absolute bottom-6 md:bottom-10 right-6 md:right-10 z-50 w-80 p-4 rounded-2xl border ${
              isScreenSharingPaused 
                ? "border-amber-500/20 bg-slate-950/80" 
                : "border-cyan-500/20 bg-slate-950/80"
            } backdrop-blur-2xl shadow-2xl overflow-hidden`}
          >
            {/* Header / Indicator */}
            <div className="flex items-center justify-between mb-2.5">
              <div className="flex items-center gap-2">
                <div className={`w-2 h-2 rounded-full ${isScreenSharingPaused ? "bg-amber-400" : "bg-cyan-400 animate-pulse"}`} />
                <span className="text-[10px] font-bold font-mono tracking-widest text-slate-200">
                  {isScreenSharingPaused ? "SCREEN VISION PAUSED" : "SCREEN VISION ACTIVE"}
                </span>
              </div>
              
              <div className="flex items-center gap-1">
                <Tooltip content="Open Screen Sharing Usage Analytics & Telemetry Dashboard" side="left">
                  <button
                    onClick={() => setShowScreenShareStats(true)}
                    className="p-1 rounded-lg bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-300 hover:text-white transition cursor-pointer border border-cyan-500/20"
                    aria-label="Screen Share Telemetry Stats"
                  >
                    <BarChart3 size={13} />
                  </button>
                </Tooltip>

                <Tooltip content="Stop screen sharing stream" side="left">
                  <button 
                    onClick={stopScreenSharing}
                    className="text-slate-400 hover:text-white transition-colors duration-150 p-1 rounded-lg hover:bg-white/5 cursor-pointer"
                    aria-label="Stop Sharing"
                  >
                    <X size={14} />
                  </button>
                </Tooltip>
              </div>
            </div>

            {/* Live Stats Mini Bar */}
            <div className="grid grid-cols-3 gap-1.5 p-2 rounded-xl bg-white/5 border border-white/5 mb-2.5 text-[10px] font-mono text-center">
              <div>
                <span className="text-slate-500 block text-[8px] uppercase">Duration</span>
                <span className="text-white font-bold">
                  {Math.floor(screenShareStats.currentSessionSeconds / 60)}:{(screenShareStats.currentSessionSeconds % 60).toString().padStart(2, '0')}
                </span>
              </div>
              <div>
                <span className="text-slate-500 block text-[8px] uppercase">Frames</span>
                <span className="text-emerald-300 font-bold">{screenShareStats.framesCaptured}</span>
              </div>
              <div>
                <span className="text-slate-500 block text-[8px] uppercase">Payload</span>
                <span className="text-cyan-300 font-bold">
                  {screenShareStats.totalPayloadBytes > 1024 * 1024 
                    ? `${(screenShareStats.totalPayloadBytes / (1024 * 1024)).toFixed(1)}M`
                    : `${(screenShareStats.totalPayloadBytes / 1024).toFixed(0)}K`}
                </span>
              </div>
            </div>

            {/* Smart Video PIP Preview Holder */}
            <div className="relative aspect-video w-full rounded-xl overflow-hidden bg-slate-900 border border-white/5 mb-3 flex items-center justify-center group select-none">
              <video
                ref={(el) => {
                  if (el && screenStreamRef.current && el.srcObject !== screenStreamRef.current) {
                    el.srcObject = screenStreamRef.current;
                    el.muted = true;
                    el.play().catch(err => console.log("Mini preview stream play issue:", err));
                  }
                }}
                className={`w-full h-full object-cover transition-opacity duration-300 ${
                  isScreenSharingPaused ? "opacity-30 blur-sm" : "opacity-90"
                }`}
                autoPlay
                playsInline
                muted
              />

              {isScreenSharingPaused && (
                <div className="absolute inset-0 flex items-center justify-center">
                  <span className="text-[10px] uppercase tracking-widest font-mono text-amber-400 font-bold px-2 py-1 bg-amber-950/40 border border-amber-500/20 rounded-md">
                    Transmission Paused
                  </span>
                </div>
              )}
              
              {!isScreenSharingPaused && screenVisionMode && (
                <div className="absolute top-2 left-2 flex items-center gap-1.5 px-2 py-0.5 rounded bg-cyan-950/50 border border-cyan-400/20 text-[9px] font-mono text-cyan-300">
                  <span className="w-1.5 h-1.5 bg-cyan-400 rounded-full animate-ping" />
                  <span>Streaming FPS: 0.5</span>
                </div>
              )}
            </div>

            {/* Quick Action Control Strip */}
            <div className="flex items-center justify-between gap-1.5 mb-2.5">
              {isScreenSharingPaused ? (
                <Tooltip content="Resume sending live visual screen frames to Gemini" side="top">
                  <button
                    onClick={resumeScreenSharing}
                    className="flex-1 py-1.5 px-2 bg-cyan-500/10 hover:bg-cyan-500/20 border border-cyan-500/20 rounded-lg text-xs font-mono font-medium text-cyan-300 flex items-center justify-center gap-1.5 transition-all cursor-pointer"
                    aria-label="Resume Screen Stream"
                  >
                    <Play size={10} />
                    <span>Resume</span>
                  </button>
                </Tooltip>
              ) : (
                <Tooltip content="Temporarily pause streaming frames without disconnecting" side="top">
                  <button
                    onClick={pauseScreenSharing}
                    className="flex-1 py-1.5 px-2 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/20 rounded-lg text-xs font-mono font-medium text-amber-300 flex items-center justify-center gap-1.5 transition-all cursor-pointer"
                    aria-label="Pause Screen Stream"
                  >
                    <Pause size={10} />
                    <span>Pause</span>
                  </button>
                </Tooltip>
              )}

              <Tooltip content="Select a different monitor, window, or tab" side="top">
                <button
                  onClick={switchScreenShare}
                  className="py-1.5 px-2 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg text-xs font-mono text-slate-300 hover:text-white flex items-center justify-center gap-1 transition-all cursor-pointer"
                  aria-label="Switch Screen Source"
                >
                  <RefreshCw size={11} />
                  <span>Switch</span>
                </button>
              </Tooltip>

              <Tooltip content="End screen sharing session" side="top">
                <button
                  onClick={stopScreenSharing}
                  className="py-1.5 px-2 bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/20 rounded-lg text-xs font-mono text-rose-400 flex items-center justify-center gap-1 transition-all cursor-pointer hover:scale-[1.02] active:scale-[0.98]"
                  aria-label="Stop Screen Sharing"
                >
                  <Square size={9} />
                  <span>Stop</span>
                </button>
              </Tooltip>
            </div>

            {/* Core Mode Configuration Toggle */}
            <div className="pt-2 border-t border-white/5 flex items-center justify-between text-left">
              <div className="flex flex-col">
                <span className="text-[10px] font-bold font-mono text-slate-200">SCREEN VISION MODE</span>
                <span className="text-[8px] text-slate-400 uppercase font-mono max-w-[150px]">Gemini Auto-Analysis</span>
              </div>
              <Tooltip content={screenVisionMode ? "Vision enabled: frames are processed by Gemini" : "Vision bypassed: screen is shown locally only"} side="top">
                <button
                  onClick={() => setScreenVisionMode(!screenVisionMode)}
                  className={`w-10 h-5 rounded-full p-0.5 transition-colors duration-200 focus:outline-none cursor-pointer ${
                    screenVisionMode ? "bg-cyan-500" : "bg-white/10"
                  }`}
                  aria-label="Toggle Screen Vision Mode"
                >
                  <div
                    className={`bg-white w-4 h-4 rounded-full shadow-md transform duration-200 ease-in-out ${
                      screenVisionMode ? "translate-x-5" : "translate-x-0"
                    }`}
                  />
                </button>
              </Tooltip>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Screen Sharing Usage Analytics Overlay */}
      <ScreenShareStatsOverlay
        stats={screenShareStats}
        isOpen={showScreenShareStats}
        onClose={() => setShowScreenShareStats(false)}
        onResetStats={handleResetScreenStats}
        themeColor={themeColor}
      />

      {/* Dynamic Ambiance Sentiment Transition Toast */}
      <AnimatePresence>
        {ambianceToast && (
          <motion.div
            initial={{ opacity: 0, y: -20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -20, scale: 0.95 }}
            className="fixed top-20 left-1/2 -translate-x-1/2 z-40 px-4 py-2 rounded-2xl bg-[#0a0b16]/90 border border-amber-400/30 text-amber-200 text-xs font-mono backdrop-blur-xl shadow-[0_0_30px_rgba(245,158,11,0.25)] flex items-center gap-2 pointer-events-none"
          >
            <Sparkles size={14} className="text-amber-300 animate-pulse" />
            <span>{ambianceToast.message}</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Voice Pitch & Speed Modulator Floating Panel */}
      <VoiceModulatorPanel
        isOpen={showVoiceModulator}
        onClose={() => setShowVoiceModulator(false)}
        onSpeedChange={(speed) => {
          sessionRef.current?.setPlaybackSpeed(speed);
        }}
        onPitchChange={(cents) => {
          sessionRef.current?.setVoicePitch(cents);
        }}
      />

      {/* Recollections sliding core panel */}
      <MemoryDashboard
        isOpen={showMemoryDashboard}
        onClose={() => setShowMemoryDashboard(false)}
        memories={memories}
        onAddMemory={handleAddManualMemory}
        onDeleteMemory={handleDeleteMemory}
        themeColor={themeColor}
      />
    </div>
  );
}
