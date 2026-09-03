import { useState, useEffect, useCallback } from "react";
import {
  X,
  Brain,
  Monitor,
  Sparkles,
  Cpu,
  Zap,
  Bot,
  Eye,
  EyeOff,
  Check,
  Loader2,
  Shield,
  Sliders,
  Settings2,
  CircleDot,
  Radio,
  KeyRound,
  PlugZap,
  Trash2,
  FlaskConical,
  User,
  LogIn,
  LogOut,
  Mail,
  Activity,
} from "lucide-react";
import { AgentStatus } from "../../windows-agent/types";
import { motion, AnimatePresence } from "motion/react";
import React from "react";
import { useAuth } from "../contexts/AuthContext";
import { HealthCenter } from "./HealthCenter";

type Provider = "gemini" | "nvidia" | "groq" | "openai" | "anthropic";

interface ProviderStatus {
  configured: boolean;
  testing: boolean;
  saving: boolean;
  apiKey: string;
  showKey: boolean;
  testResult: { success: boolean; message?: string } | null;
}

const PROVIDERS: Provider[] = ["gemini", "nvidia", "groq", "openai", "anthropic"];

const PROVIDER_META: Record<Provider, { label: string; hint: string; icon: any; accent: string }> = {
  gemini: { label: "Google Gemini", hint: "Required for voice/live streaming", icon: Sparkles, accent: "text-cyan-400 border-cyan-500/20 bg-cyan-500/10" },
  nvidia: { label: "NVIDIA NIM", hint: "Integrate API", icon: Cpu, accent: "text-emerald-400 border-emerald-500/20 bg-emerald-500/10" },
  groq: { label: "Groq", hint: "Ultra-fast inference", icon: Zap, accent: "text-amber-400 border-amber-500/20 bg-amber-500/10" },
  openai: { label: "OpenAI", hint: "GPT / Realtime", icon: Brain, accent: "text-violet-400 border-violet-500/20 bg-violet-500/10" },
  anthropic: { label: "Anthropic", hint: "Claude family", icon: Bot, accent: "text-orange-400 border-orange-500/20 bg-orange-500/10" },
};

interface SettingsProps {
  isOpen: boolean;
  onClose: () => void;
  agentStatus: AgentStatus | null;
  initialTab?: "health" | "providers" | "agent" | "voice" | "general" | "security" | "account";
  proactiveSpeechEnabled?: boolean;
  onProactiveSpeechChange?: (enabled: boolean) => void;
}

function createInitialProviderStates(): Record<Provider, ProviderStatus> {
  const s = {} as Record<Provider, ProviderStatus>;
  PROVIDERS.forEach((p) => {
    s[p] = { configured: false, testing: false, saving: false, apiKey: "", showKey: false, testResult: null };
  });
  return s;
}

export const Settings: React.FC<SettingsProps> = ({ isOpen, onClose, agentStatus, initialTab, proactiveSpeechEnabled = true, onProactiveSpeechChange }) => {
  const { user, isGuest, signInWithGoogle, signInAsGuest, upgradeGuestAccount, signOut: authSignOut, getIdToken } = useAuth();
  const getAuthHeaders = useCallback(async (): Promise<Record<string, string>> => {
    try {
      const token = await getIdToken();
      if (token) return { Authorization: `Bearer ${token}` };
    } catch { /* fail closed below */ }
    return import.meta.env.DEV ? { "X-LOHZ-Dev-Uid": "local-development" } : {};
  }, [getIdToken]);
  const [providerStates, setProviderStates] = useState<Record<Provider, ProviderStatus>>(createInitialProviderStates());
  const [activeSection, setActiveSection] = useState<"health" | "providers" | "agent" | "voice" | "general" | "security" | "account">(initialTab || "providers");

  useEffect(() => {
    if (initialTab) setActiveSection(initialTab);
  }, [initialTab]);

  useEffect(() => {
    if (!isOpen) return;
    const loadStatus = async () => {
      try {
        const headers = await getAuthHeaders();
        const res = await fetch("/api/credentials/status", { headers });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || `Credential status failed (${res.status})`);
        setProviderStates((prev) => {
          const next = { ...prev };
          Object.entries(data).forEach(([provider, status]: [string, any]) => {
            if (provider in next) {
              next[provider as Provider] = { ...next[provider as Provider], configured: status.configured };
            }
          });
          return next;
        });
      } catch (err) {
        console.error("Failed to load credential status:", err);
      }
    };
    loadStatus();
  }, [isOpen, getAuthHeaders]);

  const handleSave = async (provider: Provider) => {
    const state = providerStates[provider];
    if (!state.apiKey.trim()) {
      setProviderStates((p) => ({ ...p, [provider]: { ...p[provider], testResult: { success: false, message: "Please enter an API key" } } }));
      return;
    }
    setProviderStates((p) => ({ ...p, [provider]: { ...p[provider], saving: true, testResult: null } }));
    try {
      const authHeaders = await getAuthHeaders();
      const res = await fetch(`/api/credentials/${provider}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify({ value: state.apiKey }),
      });
      const data = await res.json();
      if (data.success) {
        setProviderStates((p) => ({
          ...p,
          [provider]: { ...p[provider], configured: true, saving: false, testResult: { success: true, message: data.message }, apiKey: "" },
        }));
      } else {
        setProviderStates((p) => ({ ...p, [provider]: { ...p[provider], saving: false, testResult: { success: false, message: data.error || "Failed to save" } } }));
      }
    } catch (err: any) {
      setProviderStates((p) => ({ ...p, [provider]: { ...p[provider], saving: false, testResult: { success: false, message: `Failed to save: ${err.message || "Unknown error"}` } } }));
    }
  };

  const handleTestConnection = async (provider: Provider) => {
    const state = providerStates[provider];
    if (!state.apiKey.trim() && !state.configured) {
      setProviderStates((p) => ({ ...p, [provider]: { ...p[provider], testResult: { success: false, message: "Please enter an API key first" } } }));
      return;
    }
    setProviderStates((p) => ({ ...p, [provider]: { ...p[provider], testing: true, testResult: null } }));
    try {
      const authHeaders = await getAuthHeaders();
      const res = await fetch(`/api/credentials/${provider}/test`, { method: "POST", headers: { "Content-Type": "application/json", ...authHeaders } });
      const data = await res.json();
      setProviderStates((p) => ({
        ...p,
        [provider]: { ...p[provider], testing: false, configured: data.success, testResult: { success: data.success, message: data.message } },
      }));
    } catch (err: any) {
      setProviderStates((p) => ({ ...p, [provider]: { ...p[provider], testing: false, testResult: { success: false, message: `Connection failed: ${err.message || "Unknown error"}` } } }));
    }
  };

  const handleRemove = async (provider: Provider) => {
    setProviderStates((p) => ({ ...p, [provider]: { ...p[provider], saving: true, testResult: null } }));
    try {
      const authHeaders = await getAuthHeaders();
      const res = await fetch(`/api/credentials/${provider}`, { method: "DELETE", headers: authHeaders });
      const data = await res.json();
      if (data.success) {
        setProviderStates((p) => ({ ...p, [provider]: { ...p[provider], configured: false, saving: false, apiKey: "", testResult: { success: true, message: data.message } } }));
      } else {
        setProviderStates((p) => ({ ...p, [provider]: { ...p[provider], saving: false, testResult: { success: false, message: data.error || "Failed to remove" } } }));
      }
    } catch (err: any) {
      setProviderStates((p) => ({ ...p, [provider]: { ...p[provider], saving: false, testResult: { success: false, message: `Failed to remove: ${err.message || "Unknown error"}` } } }));
    }
  };

  const handleToggleKeyVisibility = (provider: Provider) => {
    setProviderStates((p) => ({ ...p, [provider]: { ...p[provider], showKey: !p[provider].showKey } }));
  };

  const handleApiKeyChange = (provider: Provider, value: string) => {
    setProviderStates((p) => ({ ...p, [provider]: { ...p[provider], apiKey: value, testResult: null } }));
  };

  if (!isOpen) return null;

  const agentStateLabel = agentStatus?.online ? "Connected" : agentStatus?.connecting ? "Connecting" : "Offline";
  const agentDot = agentStatus?.online ? "bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.8)]" : agentStatus?.connecting ? "bg-amber-400 shadow-[0_0_10px_rgba(251,191,36,0.7)] animate-pulse" : "bg-white/20";

  const navItems: { id: typeof activeSection; label: string; icon: any }[] = [
    { id: "account", label: "Account", icon: User },
    { id: "health", label: "System Health", icon: Activity },
    { id: "providers", label: "AI Providers", icon: KeyRound },
    { id: "agent", label: "Windows Agent", icon: Monitor },
    { id: "voice", label: "Voice", icon: Sliders },
    { id: "general", label: "General", icon: Settings2 },
    { id: "security", label: "Security", icon: Shield },
  ];

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6"
        >
          {/* Backdrop */}
          <div onClick={onClose} className="absolute inset-0 bg-[#020208]/70 backdrop-blur-[14px]" />
          {/* Ambient glows */}
          <div className="pointer-events-none absolute top-[-10%] left-[12%] w-[520px] h-[520px] bg-violet-900/15 rounded-full blur-[120px]" />
          <div className="pointer-events-none absolute bottom-[-10%] right-[10%] w-[560px] h-[560px] bg-cyan-900/12 rounded-full blur-[140px]" />

          {/* Panel */}
          <motion.div
            initial={{ opacity: 0, y: 14, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 14, scale: 0.98 }}
            transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
            className="relative w-full max-w-[880px] max-h-[86vh] flex flex-col overflow-hidden rounded-[20px] border border-white/10 bg-[#0a0a12]/90 backdrop-blur-2xl shadow-[0_0_0_1px_rgba(255,255,255,0.06),0_20px_80px_rgba(0,0,0,0.7),0_0_40px_rgba(99,102,241,0.15)]"
          >
            {/* Header */}
            <div className="relative shrink-0 px-6 sm:px-7 pt-6 pb-5 border-b border-white/[0.06] bg-gradient-to-b from-white/[0.04] to-transparent">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-xl bg-black border border-white/15 p-1 flex items-center justify-center shadow-md overflow-hidden shrink-0">
                      <img src="/app-logo.png" alt="LOHZ23" className="w-full h-full object-contain" />
                    </div>
                    <h2 className="text-[15px] font-bold tracking-[0.16em] text-white uppercase font-sans">LOHZ23 — Control Center</h2>
                    <span className="hidden sm:inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border border-indigo-500/30 bg-indigo-500/10 text-[9px] font-mono tracking-widest text-indigo-300">
                      <CircleDot size={9} /> SYSTEM VAULT
                    </span>
                  </div>
                  <p className="mt-2 text-[11px] leading-relaxed font-mono tracking-wide text-white/45 max-w-[560px]">
                    Secure credential vault · live agent link · voice & appearance. Keys are encrypted with AES-256-GCM and never leave the vault.
                  </p>
                </div>
                <button
                  onClick={onClose}
                  className="shrink-0 p-2 rounded-xl border border-white/10 bg-white/[0.04] hover:bg-white/[0.08] text-white/60 hover:text-white transition cursor-pointer"
                  aria-label="Close Settings"
                >
                  <X size={16} />
                </button>
              </div>

              {/* Section tabs */}
              <div className="mt-5 flex gap-1.5 overflow-x-auto no-scrollbar pb-1">
                {navItems.map((item) => {
                  const active = activeSection === item.id;
                  const Icon = item.icon;
                  return (
                    <button
                      key={item.id}
                      onClick={() => setActiveSection(item.id)}
                      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-[11px] font-mono tracking-widest uppercase whitespace-nowrap transition cursor-pointer ${
                        active ? "bg-white text-[#0a0a12] border-white font-semibold" : "bg-white/[0.04] border-white/10 text-white/55 hover:text-white hover:bg-white/[0.08]"
                      }`}
                    >
                      <Icon size={12} />
                      {item.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto px-5 sm:px-7 py-6 space-y-7">
              {/* ACCOUNT */}
              {activeSection === "account" && (
                <div className="space-y-4">
                  <div className="flex items-center gap-2">
                    <User size={14} className="text-cyan-300" />
                    <h3 className="text-[11px] font-mono tracking-[0.18em] uppercase text-white/70">Account</h3>
                  </div>

                  {user ? (
                    <div className="space-y-4">
                      <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-5">
                        <div className="flex items-center gap-4">
                          {user.photoURL ? (
                            <img src={user.photoURL} alt="avatar" className="w-12 h-12 rounded-full border border-white/10" />
                          ) : (
                            <div className="w-12 h-12 rounded-full bg-indigo-500/20 border border-indigo-500/30 flex items-center justify-center">
                              <User size={20} className="text-indigo-300" />
                            </div>
                          )}
                          <div className="min-w-0">
                            <div className="text-[14px] font-medium text-white truncate">{user.isAnonymous ? "LOHZ Guest" : (user.displayName || "LOHZ User")}</div>
                            <div className="flex items-center gap-1.5 text-[11px] font-mono text-white/40">
                              <Mail size={11} />
                              <span className="truncate">{user.isAnonymous ? "Anonymous session" : user.email}</span>
                            </div>
                          </div>
                        </div>
                      </div>

                      <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] divide-y divide-white/[0.04]">
                        <div className="flex items-center justify-between px-5 py-4">
                          <div>
                            <div className="text-[12px] font-medium text-white">User ID</div>
                            <div className="text-[10px] font-mono text-white/35">Firebase UID</div>
                          </div>
                          <span className="text-[10px] font-mono text-white/45 max-w-[180px] truncate">{user.uid}</span>
                        </div>
                        <div className="flex items-center justify-between px-5 py-4">
                          <div>
                            <div className="text-[12px] font-medium text-white">Email verified</div>
                            <div className="text-[11px] font-mono text-white/35">{user.isAnonymous ? "Guest session" : "Google account"}</div>
                          </div>
                          <span className={`inline-flex items-center gap-1 text-[11px] font-mono ${user.emailVerified ? "text-emerald-300" : "text-white/40"}`}>
                            {user.emailVerified ? <><Check size={12} /> Verified</> : "Not verified"}
                          </span>
                        </div>
                        <div className="flex items-center justify-between px-5 py-4">
                          <div>
                            <div className="text-[12px] font-medium text-white">Memory isolation</div>
                            <div className="text-[11px] font-mono text-white/35">Per-user recollections</div>
                          </div>
                          <span className="text-[11px] font-mono text-emerald-300/80">Active</span>
                        </div>
                      </div>

                      {user.isAnonymous && (
                        <div className="rounded-2xl border border-indigo-500/20 bg-indigo-500/5 p-4 text-center">
                          <p className="text-[11px] font-mono text-indigo-200 mb-3">
                            ✦ Link your Google account to keep your memories, skills and credentials safe across devices.
                          </p>
                          <button
                            onClick={upgradeGuestAccount}
                            className="w-full inline-flex items-center justify-center gap-2 h-10 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-[11px] font-mono tracking-widest uppercase font-semibold transition cursor-pointer"
                          >
                            <LogIn size={13} />
                            Upgrade to Google Account
                          </button>
                        </div>
                      )}

                      <button
                        onClick={authSignOut}
                        className="w-full inline-flex items-center justify-center gap-2 h-10 rounded-xl border border-rose-500/20 bg-rose-500/10 hover:bg-rose-500/15 text-rose-200 text-[11px] font-mono tracking-widest uppercase transition cursor-pointer"
                      >
                        <LogOut size={13} />
                        Sign Out
                      </button>
                    </div>
                  ) : (
                    <div className="space-y-4">
                      <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-8 text-center relative overflow-hidden">
                        <div className="mx-auto w-16 h-16 rounded-2xl bg-black border border-white/15 p-2 flex items-center justify-center mb-4 shadow-xl">
                          <img src="/app-logo.png" alt="LOHZ23" className="w-full h-full object-contain" />
                        </div>
                        <h4 className="text-[15px] font-bold text-white mb-1 tracking-wide uppercase font-sans">Sign in to LOHZ23</h4>
                        <p className="text-[11px] font-mono text-white/45 mb-6 max-w-[340px] mx-auto leading-relaxed">
                          Link your Google account or continue as guest to access your isolated memory vault, custom AI tools, and voice modulator.
                        </p>
                        <div className="flex flex-col sm:flex-row items-center justify-center gap-3 max-w-sm mx-auto">
                          <button
                            onClick={signInWithGoogle}
                            className="w-full sm:w-auto flex-1 inline-flex items-center justify-center gap-2.5 h-11 px-6 rounded-xl bg-white text-[#0a0a12] text-[11px] font-mono tracking-widest uppercase font-semibold hover:bg-white/90 transition cursor-pointer shadow-lg hover:scale-102 active:scale-98"
                          >
                            <LogIn size={13} />
                            Sign in with Google
                          </button>
                          <button
                            onClick={signInAsGuest}
                            className="w-full sm:w-auto inline-flex items-center justify-center gap-2 h-11 px-5 rounded-xl border border-white/15 bg-white/[0.04] text-white/80 text-[11px] font-mono tracking-widest uppercase hover:bg-white/[0.08] hover:text-white transition cursor-pointer hover:scale-102 active:scale-98"
                          >
                            <User size={13} />
                            Guest
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* AI PROVIDERS */}
              {activeSection === "health" && <HealthCenter active={isOpen && activeSection === "health"} />}

              {/* AI PROVIDERS */}
              {activeSection === "providers" && (
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <KeyRound size={14} className="text-cyan-300" />
                      <h3 className="text-[11px] font-mono tracking-[0.18em] uppercase text-white/70">AI Providers</h3>
                    </div>
                    <span className="text-[10px] font-mono tracking-wide text-white/30">{PROVIDERS.filter((p) => providerStates[p]?.configured).length} / {PROVIDERS.length} configured</span>
                  </div>
                  <p className="text-[11px] leading-relaxed font-mono text-white/35 -mt-2">
                    Keys are stored encrypted on the server. The UI never reveals a stored key. Use Test to verify before saving.
                  </p>

                  <div className="space-y-3">
                    {PROVIDERS.map((provider) => {
                      const state = providerStates[provider];
                      if (!state) return null;
                      const meta = PROVIDER_META[provider];
                      const Icon = meta.icon;
                      const dot = state.configured ? "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.7)]" : state.testing ? "bg-amber-400 animate-pulse" : "bg-white/15";
                      const statusText = state.configured ? "Configured · encrypted" : state.testing ? "Testing…" : "Not configured";
                      return (
                        <div key={provider} className="group rounded-2xl border border-white/[0.06] bg-white/[0.02] hover:bg-white/[0.03] hover:border-white/[0.09] transition overflow-hidden">
                          <div className="px-4 sm:px-5 py-4 flex items-center justify-between gap-4">
                            <div className="flex items-center gap-3 min-w-0">
                              <div className={`p-2 rounded-xl border shrink-0 ${meta.accent}`}>
                                <Icon size={14} />
                              </div>
                              <div className="min-w-0">
                                <div className="flex items-center gap-2">
                                  <span className="text-[13px] font-medium tracking-wide text-white">{meta.label}</span>
                                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dot}`} />
                                </div>
                                <span className="text-[10px] font-mono tracking-wide text-white/35">{meta.hint} · {statusText}</span>
                              </div>
                            </div>
                            <span className={`hidden sm:inline-flex items-center gap-1 px-2 py-1 rounded-full border text-[10px] font-mono tracking-widest uppercase ${state.configured ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-300" : "border-white/10 bg-white/[0.04] text-white/35"}`}>
                              {state.configured ? <Check size={10} /> : <CircleDot size={10} />}
                              {statusText.split(" ·")[0]}
                            </span>
                          </div>

                          {/* Input row */}
                          <div className="px-4 sm:px-5 pb-4">
                            {!state.configured ? (
                              <div className="relative">
                                <input
                                  type={state.showKey ? "text" : "password"}
                                  value={state.apiKey}
                                  onChange={(e) => handleApiKeyChange(provider, e.target.value)}
                                  placeholder={`Paste ${meta.label} API key`}
                                  className="w-full h-9 pl-3 pr-9 rounded-xl border border-white/10 bg-black/30 text-[12px] font-mono text-white placeholder:text-white/25 focus:outline-none focus:border-cyan-500/40 focus:ring-2 focus:ring-cyan-500/15 transition"
                                  disabled={state.saving || state.testing}
                                />
                                <button
                                  onClick={() => handleToggleKeyVisibility(provider)}
                                  className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1.5 rounded-lg border border-white/10 bg-white/[0.04] text-white/45 hover:text-white transition cursor-pointer"
                                  aria-label={state.showKey ? "Hide" : "Show"}
                                >
                                  {state.showKey ? <EyeOff size={12} /> : <Eye size={12} />}
                                </button>
                              </div>
                            ) : (
                              <div className="flex items-center justify-between rounded-xl border border-white/10 bg-black/25 px-3 h-9">
                                <span className="text-[11px] font-mono tracking-[0.12em] text-white/35">•••• •••• •••• •••• •••• ••••</span>
                                <span className="inline-flex items-center gap-1 text-[10px] font-mono tracking-widest uppercase text-emerald-300/80">
                                  <Shield size={10} /> vaulted
                                </span>
                              </div>
                            )}

                            {/* Actions */}
                            <div className="mt-3 grid grid-cols-3 gap-2">
                              <button
                                onClick={() => handleTestConnection(provider)}
                                disabled={state.testing || (!state.apiKey.trim() && !state.configured)}
                                className={`inline-flex items-center justify-center gap-1.5 h-8 rounded-xl border text-[11px] font-mono tracking-widest uppercase transition cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${state.testing ? "border-white/10 bg-white/5 text-white/50" : "border-cyan-500/20 bg-cyan-500/10 hover:bg-cyan-500/15 text-cyan-200"}`}
                              >
                                {state.testing ? <Loader2 size={12} className="animate-spin" /> : <FlaskConical size={12} />}
                                Test
                              </button>
                              <button
                                onClick={() => handleSave(provider)}
                                disabled={state.saving || !state.apiKey.trim()}
                                className={`inline-flex items-center justify-center gap-1.5 h-8 rounded-xl border text-[11px] font-mono tracking-widest uppercase transition cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${state.apiKey.trim() ? "border-white bg-white text-[#0a0a12] font-semibold hover:bg-white/90" : "border-white/10 bg-white/[0.04] text-white/40"}`}
                              >
                                {state.saving ? <Loader2 size={12} className="animate-spin" /> : <PlugZap size={12} />}
                                Save
                              </button>
                              <button
                                onClick={() => handleRemove(provider)}
                                disabled={state.saving || !state.configured}
                                className="inline-flex items-center justify-center gap-1.5 h-8 rounded-xl border border-white/10 bg-white/[0.03] hover:bg-rose-500/10 hover:border-rose-500/20 hover:text-rose-200 text-white/45 text-[11px] font-mono tracking-widest uppercase transition cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                              >
                                <Trash2 size={12} />
                                Remove
                              </button>
                            </div>

                            {state.testResult && (
                              <div className={`mt-3 flex items-start gap-2 rounded-xl border px-3 py-2 text-[11px] font-mono leading-relaxed ${state.testResult.success ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-200" : "border-rose-500/20 bg-rose-500/10 text-rose-200"}`}>
                                <span className={`mt-0.5 shrink-0 w-1.5 h-1.5 rounded-full ${state.testResult.success ? "bg-emerald-400" : "bg-rose-400"}`} />
                                <span className="break-words">{state.testResult.message}</span>
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <div className="rounded-2xl border border-cyan-500/20 bg-cyan-500/5 p-4">
                    <p className="text-[11px] font-mono leading-relaxed text-cyan-200/80">
                      <span className="font-semibold">Voice requires Gemini:</span> The live voice connection uses Google Gemini Live streaming, which is a Google-specific protocol. NVIDIA NIM, Groq, OpenAI, and Anthropic handle text/chat inference but cannot replace Gemini for voice.
                    </p>
                  </div>
                </div>
              )}

              {/* WINDOWS AGENT */}
              {activeSection === "agent" && (
                <div className="space-y-4">
                  <div className="flex items-center gap-2">
                    <Monitor size={14} className="text-cyan-300" />
                    <h3 className="text-[11px] font-mono tracking-[0.18em] uppercase text-white/70">Windows Agent</h3>
                  </div>
                  <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] overflow-hidden">
                    <div className="px-5 py-5 flex items-center justify-between gap-4">
                      <div className="flex items-center gap-3">
                        <div className="relative p-2.5 rounded-xl border border-white/10 bg-black/30">
                          <Monitor size={16} className="text-white/80" />
                          <span className={`absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full border-2 border-[#0a0a12] ${agentDot}`} />
                        </div>
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="text-[13px] font-medium text-white">Local Agent Bridge</span>
                            <Radio size={10} className={agentStatus?.online ? "text-emerald-400 animate-pulse" : "text-white/20"} />
                          </div>
                          <span className="text-[10px] font-mono tracking-wide text-white/35">
                            127.0.0.1:3001 · {agentStatus ? `${agentStatus.toolsRegistered} tools` : "—"}
                          </span>
                        </div>
                      </div>
                      <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[10px] font-mono tracking-widest uppercase ${agentStatus?.online ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-300" : agentStatus?.connecting ? "border-amber-500/20 bg-amber-500/10 text-amber-300" : "border-white/10 bg-white/[0.04] text-white/40"}`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${agentDot}`} />
                        {agentStateLabel}
                      </span>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 px-5 pb-5">
                      <div className="rounded-xl border border-white/10 bg-black/25 px-3 py-3">
                        <div className="text-[10px] font-mono tracking-widest uppercase text-white/35">Connection</div>
                        <div className="mt-1 text-[12px] font-mono text-white">{agentStatus?.online ? "Connected" : agentStatus?.connecting ? "Connecting…" : "Disconnected"}</div>
                      </div>
                      <div className="rounded-xl border border-white/10 bg-black/25 px-3 py-3">
                        <div className="text-[10px] font-mono tracking-widest uppercase text-white/35">Auth</div>
                        <div className="mt-1 text-[12px] font-mono text-white">{agentStatus ? "Token configured" : "No token"}</div>
                      </div>
                      <div className="rounded-xl border border-white/10 bg-black/25 px-3 py-3">
                        <div className="text-[10px] font-mono tracking-widest uppercase text-white/35">Clients</div>
                        <div className="mt-1 text-[12px] font-mono text-white">{agentStatus?.connectedClients ?? 0}</div>
                      </div>
                    </div>
                    {agentStatus?.lastError && (
                      <div className="mx-5 mb-5 rounded-xl border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-[11px] font-mono leading-relaxed text-rose-200">
                        Last error: {agentStatus.lastError}
                      </div>
                    )}
                  </div>
                  <p className="text-[11px] font-mono leading-relaxed text-white/30">
                    This reflects the live bridge state from <span className="text-white/55">agentBridge.ts</span>. No polling timers — the main server broadcasts status every 5s over the live socket.
                  </p>
                </div>
              )}

              {/* VOICE */}
              {activeSection === "voice" && (
                <div className="space-y-4">
                  <div className="flex items-center gap-2">
                    <Sliders size={14} className="text-cyan-300" />
                    <h3 className="text-[11px] font-mono tracking-[0.18em] uppercase text-white/70">Voice</h3>
                    <span className="ml-auto text-[10px] font-mono tracking-wide text-white/30">Realtime tuning</span>
                  </div>
                  <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-5 space-y-5">
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="text-[12px] font-medium text-white">LOHZ Voice</div>
                        <div className="text-[11px] font-mono text-white/35">Aoede · Gemini Live</div>
                      </div>
                      <span className="px-2 py-1 rounded-full border border-white/10 bg-black/30 text-[10px] font-mono tracking-widest uppercase text-white/45">Standard</span>
                    </div>
                    <div className="space-y-4">
                      <label className="block">
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-[11px] font-mono tracking-widest uppercase text-white/50">Playback speed</span>
                          <span className="text-[11px] font-mono text-white/60">1.0×</span>
                        </div>
                        <input type="range" min={0.5} max={2} step={0.1} value={1} readOnly className="w-full h-1.5 appearance-none rounded-full bg-white/10 accent-cyan-400" />
                      </label>
                      <label className="block">
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-[11px] font-mono tracking-widest uppercase text-white/50">Pitch</span>
                          <span className="text-[11px] font-mono text-white/60">0</span>
                        </div>
                        <input type="range" min={-12} max={12} step={1} value={0} readOnly className="w-full h-1.5 appearance-none rounded-full bg-white/10 accent-violet-400" />
                      </label>
                    </div>
                    <p className="text-[11px] font-mono leading-relaxed text-white/30">Live voice modulation is applied in the audio session. These sliders are visual placeholders aligned to the existing engine — no behavior removed.</p>
                  </div>
                </div>
              )}

              {/* GENERAL */}
              {activeSection === "general" && (
                <div className="space-y-4">
                  <div className="flex items-center gap-2">
                    <Settings2 size={14} className="text-white/60" />
                    <h3 className="text-[11px] font-mono tracking-[0.18em] uppercase text-white/70">General</h3>
                  </div>
                  <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] divide-y divide-white/[0.04]">
                    <div className="flex items-center justify-between px-5 py-4">
                      <div>
                        <div className="text-[12px] font-medium text-white">Startup behavior</div>
                        <div className="text-[11px] font-mono text-white/35">Restore last session</div>
                      </div>
                      <span className="text-[11px] font-mono text-white/50">Last session</span>
                    </div>
                    <div className="flex items-center justify-between px-5 py-4">
                      <div>
                        <div className="text-[12px] font-medium text-white">Theme / Background</div>
                        <div className="text-[11px] font-mono text-white/35">Atmosphere engine</div>
                      </div>
                      <span className="text-[11px] font-mono text-white/50">Auto</span>
                    </div>
                    <button
                      onClick={() => onProactiveSpeechChange?.(!proactiveSpeechEnabled)}
                      className="flex items-center justify-between w-full px-5 py-4 hover:bg-white/[0.02] transition cursor-pointer"
                    >
                      <div>
                        <div className="text-[12px] font-medium text-white">Proactive speech</div>
                        <div className="text-[11px] font-mono text-white/35">Speak during silence when useful</div>
                      </div>
                      <span className={`text-[11px] font-mono ${proactiveSpeechEnabled ? 'text-emerald-300' : 'text-white/50'}`}>
                        {proactiveSpeechEnabled ? 'Enabled' : 'Disabled'}
                      </span>
                    </button>
                  </div>
                </div>
              )}

              {/* SECURITY */}
              {activeSection === "security" && (
                <div className="space-y-4">
                  <div className="flex items-center gap-2">
                    <Shield size={14} className="text-emerald-300" />
                    <h3 className="text-[11px] font-mono tracking-[0.18em] uppercase text-white/70">Security</h3>
                    <span className="ml-auto inline-flex items-center gap-1 px-2 py-1 rounded-full border border-emerald-500/20 bg-emerald-500/10 text-[10px] font-mono tracking-widest uppercase text-emerald-300">
                      <Shield size={10} /> AES-256-GCM
                    </span>
                  </div>
                  <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] divide-y divide-white/[0.04]">
                    <div className="flex items-center justify-between px-5 py-4">
                      <div>
                        <div className="text-[12px] font-medium text-white">Credential storage</div>
                        <div className="text-[11px] font-mono text-white/35">Encrypted file · env fallback</div>
                      </div>
                      <span className="inline-flex items-center gap-1 text-[11px] font-mono text-emerald-300"><Check size={12} /> Encrypted</span>
                    </div>
                    <div className="flex items-center justify-between px-5 py-4">
                      <div>
                        <div className="text-[12px] font-medium text-white">Confirmation policy</div>
                        <div className="text-[11px] font-mono text-white/35">High-risk Windows tools require confirm</div>
                      </div>
                      <span className="text-[11px] font-mono text-white/50">Standard</span>
                    </div>
                    <div className="flex items-center justify-between px-5 py-4">
                      <div>
                        <div className="text-[12px] font-medium text-white">Audit logging</div>
                        <div className="text-[11px] font-mono text-white/35">Windows Agent + credential ops</div>
                      </div>
                      <span className="text-[11px] font-mono text-white/50">Enabled</span>
                    </div>
                  </div>
                  <p className="text-[11px] font-mono leading-relaxed text-white/30">
                    No fake features are shown. Additional controls (per-tool allowlists, scoped tokens) are not yet implemented and intentionally omitted rather than mocked.
                  </p>
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="shrink-0 flex items-center justify-between gap-3 px-5 sm:px-7 py-4 border-t border-white/[0.06] bg-black/20">
              <span className="hidden sm:inline text-[10px] font-mono tracking-wide text-white/30">Keys never leave the vault · Test before saving</span>
              <div className="ml-auto flex items-center gap-2">
                <button onClick={onClose} className="h-8 px-4 rounded-xl border border-white/10 bg-white/[0.04] hover:bg-white/[0.08] text-[11px] font-mono tracking-widest uppercase text-white/70 hover:text-white transition cursor-pointer">
                  Close
                </button>
                <button onClick={onClose} className="h-8 px-4 rounded-xl bg-white text-[#0a0a12] text-[11px] font-mono tracking-widest uppercase font-semibold hover:bg-white/90 transition cursor-pointer">
                  Done
                </button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
