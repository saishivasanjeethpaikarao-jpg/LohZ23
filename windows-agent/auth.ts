/**
 * Authentication bootstrap for the Windows Agent.
 *
 * Token rules:
 * - If env LOHZ_AGENT_TOKEN is set, both sides must use it.
 * - Otherwise the agent generates a 256-bit hex token on first run and writes it
 *   to <project>/.agent-token (gitignored). The main server's agentBridge reads
 *   the same file.
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { runtimePrivateFile } from "../src/lib/runtimePaths";

const TOKEN_FILE = runtimePrivateFile(".agent-token");
const ENV_NAME = "LOHZ_AGENT_TOKEN";

export function resolveToken(): { token: string; source: "env" | "file" | "generated" } {
  const fromEnv = process.env[ENV_NAME];
  if (fromEnv && fromEnv.trim().length >= 32) {
    return { token: fromEnv.trim(), source: "env" };
  }
  if (fs.existsSync(TOKEN_FILE)) {
    try {
      const existing = fs.readFileSync(TOKEN_FILE, "utf-8").trim();
      if (existing.length >= 32) return { token: existing, source: "file" };
    } catch {}
  }
  const generated = crypto.randomBytes(32).toString("hex");
  try {
    fs.writeFileSync(TOKEN_FILE, generated + "\n", { encoding: "utf-8" });
    // Restrict permissions on POSIX (no-op on Windows but harmless).
    try {
      fs.chmodSync(TOKEN_FILE, 0o600);
    } catch {}
  } catch (err) {
    console.warn("[Auth] Could not persist .agent-token:", (err as Error).message);
  }
  return { token: generated, source: "generated" };
}

export function tokenFilePath(): string {
  return TOKEN_FILE;
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** Express-style middleware factory that validates Bearer tokens. */
export function bearerAuth(expectedToken: string) {
  return (req: any, res: any, next: any) => {
    const header = req.headers["authorization"] || req.headers["Authorization"];
    if (typeof header !== "string" || !header.startsWith("Bearer ")) {
      res.status(401).json({ error: "UNAUTHORIZED", message: "Missing bearer token." });
      return;
    }
    const supplied = header.slice("Bearer ".length).trim();
    if (!safeEqual(supplied, expectedToken)) {
      res.status(403).json({ error: "FORBIDDEN", message: "Invalid token." });
      return;
    }
    next();
  };
}
