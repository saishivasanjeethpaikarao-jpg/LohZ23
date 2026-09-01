import { useCallback, useEffect, useState } from "react";
import { Activity, AlertTriangle, CheckCircle2, CircleHelp, RefreshCw, XCircle } from "lucide-react";
import type { HealthSnapshot, SubsystemHealth } from "../lib/health/types";
import { useAuth } from "../contexts/AuthContext";

const tone: Record<SubsystemHealth["status"], { text: string; border: string; bg: string; bar: string; icon: typeof CheckCircle2 }> = {
  healthy: { text: "text-emerald-300", border: "border-emerald-500/20", bg: "bg-emerald-500/[0.07]", bar: "bg-emerald-400", icon: CheckCircle2 },
  degraded: { text: "text-amber-300", border: "border-amber-500/20", bg: "bg-amber-500/[0.07]", bar: "bg-amber-400", icon: AlertTriangle },
  critical: { text: "text-rose-300", border: "border-rose-500/20", bg: "bg-rose-500/[0.07]", bar: "bg-rose-400", icon: XCircle },
  offline: { text: "text-rose-300", border: "border-rose-500/20", bg: "bg-rose-500/[0.07]", bar: "bg-rose-400", icon: XCircle },
  unknown: { text: "text-slate-300", border: "border-white/10", bg: "bg-white/[0.03]", bar: "bg-slate-500", icon: CircleHelp },
  stale: { text: "text-orange-300", border: "border-orange-500/20", bg: "bg-orange-500/[0.07]", bar: "bg-orange-400", icon: AlertTriangle },
};

const prettyStatus = (status: SubsystemHealth["status"]): string => status.charAt(0).toUpperCase() + status.slice(1);

export function HealthCenter({ active }: { active: boolean }) {
  const { getIdToken } = useAuth();
  const [snapshot, setSnapshot] = useState<HealthSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    setLoading(true); setError(null);
    try {
      const token = await getIdToken();
      const headers: Record<string, string> = token
        ? { Authorization: `Bearer ${token}` }
        : import.meta.env.DEV ? { "X-LOHZ-Dev-Uid": "local-development" } : {};
      const response = await fetch("/api/health", { headers, cache: "no-store", signal });
      const body = await response.json();
      if (!response.ok) throw new Error(body?.error || `Health request failed (${response.status})`);
      setSnapshot(body as HealthSnapshot);
    } catch (reason) {
      if ((reason as Error)?.name !== "AbortError") setError((reason as Error)?.message || "Health is unavailable");
    } finally { if (!signal?.aborted) setLoading(false); }
  }, [getIdToken]);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    void refresh(controller.signal);
    const timer = window.setInterval(() => void refresh(controller.signal), 15_000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [active, refresh]);

  const overallTone = snapshot?.status === "healthy" ? "text-emerald-300"
    : snapshot?.status === "degraded" ? "text-amber-300" : "text-rose-300";

  return (
    <section aria-labelledby="lohz-health-title" className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Activity size={14} className="text-cyan-300" aria-hidden="true" />
            <h3 id="lohz-health-title" className="text-[11px] font-mono tracking-[0.18em] uppercase text-white/70">LOHZ System Health</h3>
          </div>
          <p className="mt-2 text-[11px] font-mono leading-relaxed text-white/40">Measured runtime capability—not a simulated confidence display.</p>
        </div>
        <button
          type="button" onClick={() => void refresh()} disabled={loading}
          className="inline-flex items-center gap-1.5 h-8 px-3 rounded-xl border border-cyan-500/20 bg-cyan-500/10 text-[10px] font-mono tracking-widest uppercase text-cyan-200 hover:bg-cyan-500/15 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/70 motion-reduce:transition-none transition"
          aria-label="Refresh LOHZ health"
        >
          <RefreshCw size={12} className={loading ? "animate-spin motion-reduce:animate-none" : ""} aria-hidden="true" />
          Refresh
        </button>
      </div>

      <div aria-live="polite" aria-atomic="true">
        {error ? (
          <div role="alert" className="rounded-2xl border border-rose-500/20 bg-rose-500/10 p-4 text-[11px] font-mono text-rose-200">{error}</div>
        ) : !snapshot ? (
          <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-6 text-center text-[11px] font-mono text-white/40">Measuring operational state…</div>
        ) : (
          <>
            <div className="relative overflow-hidden rounded-2xl border border-white/[0.08] bg-gradient-to-br from-cyan-500/[0.08] via-white/[0.025] to-violet-500/[0.08] p-5">
              <div className="pointer-events-none absolute -right-12 -top-16 h-40 w-40 rounded-full bg-cyan-400/10 blur-3xl" />
              <div className="relative flex items-end justify-between gap-5">
                <div>
                  <div className="text-[10px] font-mono tracking-[0.2em] uppercase text-white/40">Overall</div>
                  <div className={`mt-1 text-3xl font-light tracking-tight ${overallTone}`}>{snapshot.overallScore}<span className="text-base text-white/30">%</span></div>
                </div>
                <div className={`text-[11px] font-mono tracking-[0.18em] uppercase ${overallTone}`}>{snapshot.status}</div>
              </div>
              <div
                className="relative mt-4 h-2 overflow-hidden rounded-full bg-black/40 ring-1 ring-white/[0.06]"
                role="progressbar" aria-label="Overall LOHZ health" aria-valuemin={0} aria-valuemax={100} aria-valuenow={snapshot.overallScore}
              >
                <div className="h-full rounded-full bg-gradient-to-r from-violet-500 via-cyan-400 to-emerald-400 transition-[width] duration-500 motion-reduce:transition-none" style={{ width: `${snapshot.overallScore}%` }} />
              </div>
              <div className="mt-3 text-[10px] font-mono text-white/30">Updated {new Date(snapshot.generatedAt).toLocaleTimeString()} · scores capped below synthetic 100%</div>
            </div>

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {snapshot.subsystems.map((system) => {
                const style = tone[system.status]; const Icon = style.icon;
                return (
                  <article key={system.capabilityId} className={`rounded-xl border p-3.5 ${style.border} ${style.bg}`}>
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex min-w-0 items-center gap-2.5">
                        <Icon size={14} className={`shrink-0 ${style.text}`} aria-hidden="true" />
                        <div className="min-w-0">
                          <div className="truncate text-[12px] font-medium text-white/90">{system.label}</div>
                          <div className="mt-0.5 truncate text-[9px] font-mono tracking-wide text-white/30">{system.detailCode || "no verified observation"}</div>
                        </div>
                      </div>
                      <span className={`shrink-0 text-[9px] font-mono tracking-widest uppercase ${style.text}`}>{prettyStatus(system.status)}</span>
                    </div>
                    <div className="mt-3 flex items-center gap-2">
                      <div className="h-1 flex-1 overflow-hidden rounded-full bg-black/35">
                        <div className={`h-full rounded-full ${style.bar}`} style={{ width: `${system.score}%` }} />
                      </div>
                      <span className="w-7 text-right text-[9px] font-mono text-white/35">{system.score}</span>
                    </div>
                  </article>
                );
              })}
            </div>

            {snapshot.tools.length > 0 && (
              <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4">
                <div className="mb-3 text-[10px] font-mono tracking-[0.18em] uppercase text-white/45">Observed tool reliability</div>
                <div className="flex flex-wrap gap-2">
                  {snapshot.tools.map((tool) => (
                    <span key={tool.capabilityId} className={`rounded-full border px-2.5 py-1 text-[10px] font-mono ${tone[tool.status].border} ${tone[tool.status].text}`}>
                      {tool.label} · {Math.round(tool.reliability * 100)}%
                    </span>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

