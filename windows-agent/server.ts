/**
 * Windows Agent server: Express + native WebSocket on port 3001.
 * Listens only on 127.0.0.1. Token-authenticated.
 * Hosts /tools (list) and /execute (POST) HTTP endpoints + a WebSocket for bridge.
 */
import express, { Request, Response } from "express";
import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import path from "node:path";
import fs from "node:fs";
import { logExecution } from "./utils/logging";
import { resolveToken, safeEqual } from "./auth";
import { executeTool } from "./toolExecutor";
import { getAllTools, getRisk } from "./toolRegistry";
import type { AgentStatus } from "./types";
import { ExecutionReplayCache } from "./replayCache";

export const AGENT_PORT = Number(process.env.LOHZ_AGENT_PORT) || 3001;
const AGENT_HOST = "127.0.0.1";

function bearerAuth(token: string) {
  return (req: Request, res: Response, next: express.NextFunction) => {
    const header = req.headers["authorization"] || "";
    const raw = Array.isArray(header) ? header.join("") : header;
    if (!raw.startsWith("Bearer ")) {
      res.status(401).json({ success: false, error: { code: "UNAUTHORIZED" } });
      return;
    }
    const presented = raw.slice("Bearer ".length).trim();
    if (!safeEqual(presented, token)) {
      res.status(401).json({ success: false, error: { code: "UNAUTHORIZED" } });
      return;
    }
    next();
  };
}

export function createAgentApp(
  token: string,
  deps: { execute?: typeof executeTool; replay?: ExecutionReplayCache<Awaited<ReturnType<typeof executeTool>>> } = {}
) {
  const runTool = deps.execute ?? executeTool;
  const replay = deps.replay ?? new ExecutionReplayCache<Awaited<ReturnType<typeof executeTool>>>();
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "2mb" }));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", agent: "lohz-windows-agent", version: "1.0.0" });
  });

  app.get("/tools", bearerAuth(token), (_req, res) => {
    const tools = getAllTools().map((t) => ({
      name: t.name,
      description: t.description,
      risk: t.risk,
      category: t.category,
      parameters: t.parameters,
    }));
    res.json({ success: true, tools });
  });

  app.post("/execute", bearerAuth(token), async (req, res) => {
    const body = req.body || {};
    const name = typeof body.name === "string" ? body.name : "";
    const requestId = typeof body.requestId === "string" ? body.requestId : "";
    const params = body.params && typeof body.params === "object" ? body.params : {};
    if (!name || !requestId) {
      res.status(400).json({ success: false, error: { code: "BAD_REQUEST", details: "Missing name or requestId." } });
      return;
    }
    try {
      const result = await replay.run(requestId, () => runTool(name, params));
      const status = result.success ? 200 : 400;
      res.status(status).json(result);
    } catch (err: any) {
      logExecution({
        tool: name,
        params: {},
        risk: getRisk(name) || "UNKNOWN",
        success: false,
        durationMs: 0,
        errorCode: "SERVER_ERROR",
        message: err && err.message ? String(err.message) : "Unexpected server error.",
      });
      res.status(500).json({
        success: false,
        tool: name,
        message: "Server error.",
        data: {},
        error: { code: "SERVER_ERROR", details: err && err.message ? String(err.message) : "" },
      });
    }
  });

  app.use((_req, res) => {
    res.status(404).json({ success: false, error: { code: "NOT_FOUND" } });
  });

  return app;
}

export function ensureWorkspaceDirs() {
  const root = path.resolve(process.cwd());
  const logsDir = path.join(root, "windows-agent", "logs");
  const shotsDir = path.join(root, "windows-agent", "screenshots");
  for (const dir of [logsDir, shotsDir]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
  return { logsDir, shotsDir };
}

export interface AgentServerHandle {
  server: http.Server;
  wss: WebSocketServer;
  port: number;
  status: AgentStatus;
  broadcastStatus: (s: AgentStatus) => void;
}

export function startAgentServer(): AgentServerHandle {
  const tokenObj = resolveToken();
  const token = tokenObj.token;
  const replay = new ExecutionReplayCache<Awaited<ReturnType<typeof executeTool>>>();
  const app = createAgentApp(token, { replay });
  const server = http.createServer(app);

  const wss = new WebSocketServer({
    server,
    path: "/ws",
    maxPayload: 2 * 1024 * 1024,
    verifyClient: (info, done) => {
      try {
        const parsed = new URL(info.req.url || "", `http://${AGENT_HOST}`);
        done(safeEqual(parsed.searchParams.get("token") || "", token), 401, "Unauthorized");
      } catch {
        done(false, 401, "Unauthorized");
      }
    },
  });

  const status: AgentStatus = {
    online: true,
    connectedClients: 0,
    lastActivityAt: Date.now(),
    toolsRegistered: getAllTools().length,
    host: AGENT_HOST,
    port: AGENT_PORT,
  };

  function broadcastStatus(next: AgentStatus) {
    Object.assign(status, next);
    status.lastActivityAt = Date.now();
    const payload = JSON.stringify({ type: "status", status });
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }

  wss.on("connection", (socket, req) => {
    status.connectedClients = wss.clients.size;
    socket.send(JSON.stringify({ type: "status", status }));

    socket.on("message", async (raw) => {
      let parsed: any;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        socket.send(JSON.stringify({ type: "error", error: { code: "BAD_JSON" } }));
        return;
      }

      if (parsed && parsed.type === "execute") {
        const name = typeof parsed.name === "string" ? parsed.name : "";
        const params = parsed.params && typeof parsed.params === "object" ? parsed.params : {};
        const requestId = typeof parsed.requestId === "string" ? parsed.requestId : null;

        if (!requestId) {
          socket.send(JSON.stringify({ type: "error", error: { code: "MISSING_REQUEST_ID" } }));
          return;
        }
        socket.send(JSON.stringify({ type: "ack", requestId }));

        try {
          const result = await replay.run(requestId, () => executeTool(name, params));
          socket.send(
            JSON.stringify({
              type: "result",
              requestId,
              result,
            })
          );
        } catch (err: any) {
          socket.send(
            JSON.stringify({
              type: "result",
              requestId,
              result: {
                success: false,
                tool: name,
                message: "Server error.",
                data: {},
                error: { code: "SERVER_ERROR", details: err && err.message ? String(err.message) : "" },
              },
            })
          );
        }
      } else if (parsed && parsed.type === "ping") {
        socket.send(JSON.stringify({ type: "pong", at: Date.now() }));
      }
    });

    socket.on("close", () => {
      status.connectedClients = wss.clients.size;
      broadcastStatus(status);
    });
  });

  server.listen(AGENT_PORT, AGENT_HOST, () => {
    // eslint-disable-next-line no-console
    console.log(`[LOHZ Windows Agent] Listening on http://${AGENT_HOST}:${AGENT_PORT}`);
  });

  return {
    server,
    wss,
    port: AGENT_PORT,
    status,
    broadcastStatus,
  };
}
