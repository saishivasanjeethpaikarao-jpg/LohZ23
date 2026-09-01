/**
 * Agent Bridge — main-server-side client that talks to the local Windows Agent
 * over WebSocket (preferred) with HTTP fallback. Localhost-only, token-authenticated.
 *
 * Responsibilities:
 *  - Connect to ws://127.0.0.1:3001/ws?token=...
 *  - Auto-reconnect with exponential backoff (capped)
 *  - Issue tool execution requests, receive structured results
 *  - Track agent online/offline status, broadcast to listeners
 *  - Provide HTTP fallback via fetch to /execute when WS is unavailable
 */
import http from "node:http";
import { WebSocket } from "ws";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { resolveToken as resolveAgentToken } from "./windows-agent/auth";

export type AgentStatus = {
  online: boolean;
  connecting: boolean;
  connectedClients: number;
  toolsRegistered: number;
  lastError: string | null;
  lastActivityAt: number;
  host: string;
  port: number;
};

export type BridgeToolResult = {
  success: boolean;
  tool: string;
  message: string;
  data: Record<string, any>;
  error: { code: string; details?: string } | null;
};

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3001;

function readPersistedToken(): string | null {
  const tokenPath = path.resolve(process.cwd(), ".agent-token");
  if (!existsSync(tokenPath)) return null;
  try {
    const raw = readFileSync(tokenPath, "utf8").trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

export function resolveBridgeToken(): string {
  const env = process.env.LOHZ_AGENT_TOKEN;
  if (env && env.trim().length > 0) return env.trim();
  const file = readPersistedToken();
  if (file) return file;
  // First run with no token anywhere: generate + persist a 256-bit token
  // using the same resolver the Windows Agent uses, so both sides
  // converge on one shared secret instead of failing to start.
  const { token } = resolveAgentToken();
  return token;
}

type PendingResolver = {
  resolve: (value: BridgeToolResult) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
};

export type AgentStatusListener = (status: AgentStatus) => void;

export class AgentBridge {
  private host: string;
  private port: number;
  private token: string;
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private destroyed = false;
  private pending = new Map<string, PendingResolver>();
  private statusListeners = new Set<AgentStatusListener>();
  private status: AgentStatus;

  constructor(opts: { host?: string; port?: number; token?: string } = {}) {
    this.host = opts.host || process.env.LOHZ_AGENT_HOST || DEFAULT_HOST;
    if (this.host !== "127.0.0.1" && this.host !== "localhost") {
      throw new Error("AgentBridge only permits a loopback Windows Agent host");
    }
    this.port = opts.port || Number(process.env.LOHZ_AGENT_PORT) || DEFAULT_PORT;
    this.token = opts.token || resolveBridgeToken();
    this.status = {
      online: false,
      connecting: false,
      connectedClients: 0,
      toolsRegistered: 0,
      lastError: null,
      lastActivityAt: 0,
      host: this.host,
      port: this.port,
    };
  }

  onStatus(listener: AgentStatusListener): () => void {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => this.statusListeners.delete(listener);
  }

  getStatus(): AgentStatus {
    return { ...this.status };
  }

  private updateStatus(patch: Partial<AgentStatus>) {
    this.status = { ...this.status, ...patch, lastActivityAt: Date.now() };
    for (const listener of this.statusListeners) {
      try {
        listener(this.status);
      } catch {
        // ignore listener errors
      }
    }
  }

  start() {
    if (this.destroyed) return;
    this.connect();
  }

  stop() {
    this.destroyed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
    for (const [, pending] of this.pending) {
      pending.reject(new Error("Bridge stopped."));
    }
    this.pending.clear();
    this.updateStatus({ online: false, connecting: false });
  }

  private scheduleReconnect() {
    if (this.destroyed) return;
    const delay = Math.min(30000, 500 * Math.pow(2, this.reconnectAttempts));
    this.reconnectAttempts++;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private connect() {
    if (this.destroyed) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.updateStatus({ connecting: true });
    const url = `ws://${this.host}:${this.port}/ws?token=${encodeURIComponent(this.token)}`;

    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch (err: any) {
      this.updateStatus({ connecting: false, online: false, lastError: err && err.message ? String(err.message) : "ws construction failed" });
      this.scheduleReconnect();
      return;
    }
    this.ws = socket;

    socket.on("open", () => {
      this.reconnectAttempts = 0;
      this.updateStatus({ online: true, connecting: false, lastError: null });
    });

    socket.on("message", (raw) => {
      let parsed: any;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (parsed && parsed.type === "status" && parsed.status) {
        const s = parsed.status;
        this.updateStatus({
          online: true,
          connecting: false,
          connectedClients: Number(s.connectedClients) || 0,
          toolsRegistered: Number(s.toolsRegistered) || 0,
          lastError: null,
        });
      } else if (parsed && parsed.type === "result" && parsed.requestId) {
        const pending = this.pending.get(parsed.requestId);
        if (pending) {
          this.pending.delete(parsed.requestId);
          clearTimeout(pending.timer);
          pending.resolve(parsed.result);
        }
      } else if (parsed && parsed.type === "pong") {
        // heartbeat
      } else if (parsed && parsed.type === "ack" && parsed.requestId) {
        // ack received — keep waiting for result
      }
    });

    socket.on("close", () => {
      this.ws = null;
      this.rejectPending("Windows Agent connection closed before a result was received.");
      this.updateStatus({ online: false, connecting: false });
      this.scheduleReconnect();
    });

    socket.on("error", (err: any) => {
      this.updateStatus({
        connecting: false,
        online: false,
        lastError: err && err.message ? String(err.message) : "ws error",
      });
    });
  }

  /**
   * Execute a tool on the Windows Agent. Prefers WebSocket, falls back to HTTP.
   */
  async executeTool(name: string, params: Record<string, any>, timeoutMs = 30000): Promise<BridgeToolResult> {
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return this.executeViaWs(requestId, name, params, timeoutMs);
    }
    return this.executeViaHttp(requestId, name, params, timeoutMs);
  }

  private executeViaWs(requestId: string, name: string, params: Record<string, any>, timeoutMs: number): Promise<BridgeToolResult> {
    return new Promise<BridgeToolResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("Tool execution timed out."));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      try {
        this.ws!.send(
          JSON.stringify({
            type: "execute",
            requestId,
            name,
            params: params || {},
          })
        );
      } catch (err: any) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private executeViaHttp(requestId: string, name: string, params: Record<string, any>, timeoutMs: number): Promise<BridgeToolResult> {
    return new Promise<BridgeToolResult>((resolve, reject) => {
      const body = JSON.stringify({ requestId, name, params: params || {} });
      const req = http.request(
        {
          host: this.host,
          port: this.port,
          path: "/execute",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
            Authorization: `Bearer ${this.token}`,
          },
          timeout: timeoutMs,
        },
        (res) => {
          let chunks = "";
          res.on("data", (c) => (chunks += c.toString()));
          res.on("end", () => {
            try {
              const parsed = JSON.parse(chunks);
              resolve(parsed as BridgeToolResult);
            } catch (err: any) {
              reject(new Error("Malformed response from agent."));
            }
          });
        }
      );
      req.on("error", (err) => reject(err));
      req.on("timeout", () => {
        req.destroy(new Error("Tool execution timed out."));
      });
      req.write(body);
      req.end();
    });
  }

  private rejectPending(message: string): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    this.pending.clear();
  }
}

let singleton: AgentBridge | null = null;

export function getAgentBridge(): AgentBridge {
  if (!singleton) {
    singleton = new AgentBridge();
  }
  return singleton;
}
