/**
 * Desktop Authentication Routes
 * Implements secure browser-based auth handoff for LOHZ desktop (Electron).
 *
 * Flow:
 *  1. Desktop opens system browser to GET /auth/desktop
 *  2. Server serves LOHZ-branded page with embedded one-time code+state
 *  3. User signs in (Google/guest); page POSTs to /api/auth/desktop-exchange
 *  4. Server validates code+state (single-use, TTL) and verifies ID token
 *  5. Result stored; desktop polls GET /auth/callback-result?state=...
 *  6. Desktop receives uid and completes auth in renderer
 *
 * Security:
 *  - One-time code replay protection
 *  - State CSRF protection with constant-time comparison
 *  - 5-minute code TTL, 2-minute callback window
 *  - ID token verified server-side by Firebase Admin SDK
 *  - No Admin credentials leave the server
 */

import crypto from "crypto";
import { Router, Request, Response } from "express";
import { getAuth as getAdminAuth } from "firebase-admin/auth";
import { issueAuthCode, consumeAuthCode } from "./sessionStore.js";
import { initFirebaseAdmin } from "./authMiddleware.js";

const pendingCallbacks = new Map<string, { uid: string; issuedAt: number }>();
const CALLBACK_TTL_MS = 120_000;

function sweepCallbacks(): void {
  const cutoff = Date.now() - CALLBACK_TTL_MS;
  for (const [key, entry] of pendingCallbacks.entries()) {
    if (entry.issuedAt < cutoff) pendingCallbacks.delete(key);
  }
}

export function registerDesktopAuthRoutes(
  router: Router,
  firebaseConfig: Record<string, string>
): void {
  router.get("/auth/desktop", (_req: Request, res: Response) => {
    const { code, state } = issueAuthCode();
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.send(buildAuthPage(code, state, firebaseConfig));
  });

  router.post("/api/auth/desktop-exchange", async (req: Request, res: Response) => {
    const { code, state, idToken } = req.body ?? {};

    if (typeof code !== "string" || typeof state !== "string" || typeof idToken !== "string") {
      res.status(400).json({ ok: false, error: "Missing required fields: code, state, idToken" });
      return;
    }

    const result = consumeAuthCode(code, state);
    if (result.ok !== true) {
      const reason = result.reason;
      const statusMap: Record<string, number> = {
        not_found: 401, expired: 401, consumed: 401, state_mismatch: 403,
      };
      const messages: Record<string, string> = {
        not_found: "Authorization code not found or already expired.",
        expired: "Authorization code has expired. Please start the sign-in flow again.",
        consumed: "Authorization code has already been used. Please start the sign-in flow again.",
        state_mismatch: "State parameter mismatch. Possible CSRF attempt rejected.",
      };
      res.status(statusMap[reason] ?? 401).json({
        ok: false, error: messages[reason] ?? "Invalid authorization code.",
      });
      return;
    }

    if (!initFirebaseAdmin()) {
      res.status(503).json({ ok: false, error: "Authentication service is not configured." });
      return;
    }

    let uid: string;
    try {
      const decoded = await getAdminAuth().verifyIdToken(idToken);
      uid = decoded.uid;
    } catch {
      res.status(401).json({ ok: false, error: "Firebase ID token is invalid or expired." });
      return;
    }

    sweepCallbacks();
    pendingCallbacks.set(state, { uid, issuedAt: Date.now() });
    res.json({ ok: true, uid, state });
  });

  router.get("/auth/callback-result", (req: Request, res: Response) => {
    sweepCallbacks();
    const state = req.query["state"];
    if (typeof state !== "string") {
      res.status(400).json({ ready: false, error: "Missing state parameter" });
      return;
    }
    const entry = pendingCallbacks.get(state);
    if (!entry) { res.json({ ready: false }); return; }
    pendingCallbacks.delete(state);
    res.json({ ready: true, uid: entry.uid });
  });

  router.post("/api/auth/guest-session", async (_req: Request, res: Response) => {
    if (!initFirebaseAdmin()) {
      res.status(503).json({ ok: false, error: "Authentication service is not configured." });
      return;
    }
    try {
      const uid = "guest_" + crypto.randomUUID();
      const customToken = await getAdminAuth().createCustomToken(uid, { guest: true });
      res.json({ ok: true, customToken, uid });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      res.status(500).json({ ok: false, error: "Failed to create guest session: " + msg });
    }
  });
}

function buildAuthPage(
  code: string,
  state: string,
  firebaseConfig: Record<string, string>
): string {
  const safeCode = code.replace(/[^a-f0-9]/gi, "");
  const safeState = state.replace(/[^a-f0-9]/gi, "");
  const configJson = JSON.stringify(firebaseConfig);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>LOHZ — Sign In</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #070b14; color: #e2e8f0;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 1.5rem; }
    .card { width: 100%; max-width: 420px; background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.10); border-radius: 1.25rem;
      padding: 2.5rem 2rem; text-align: center; }
    .logo { font-size: 1.5rem; font-weight: 700; letter-spacing: 0.4em; color: #fff; margin-bottom: 0.5rem; }
    .sub { font-size: 0.8rem; color: rgba(255,255,255,0.4); letter-spacing: 0.15em;
      margin-bottom: 2rem; font-family: ui-monospace, monospace; }
    h2 { font-size: 1.1rem; font-weight: 600; margin-bottom: 0.5rem; color: #f1f5f9; }
    p { font-size: 0.82rem; color: rgba(255,255,255,0.45); line-height: 1.6; margin-bottom: 1.75rem; }
    .btn { display: flex; align-items: center; justify-content: center; gap: 0.6rem;
      width: 100%; padding: 0.75rem 1.25rem; border-radius: 0.75rem; border: none;
      font-size: 0.85rem; font-weight: 600; cursor: pointer; transition: opacity 0.15s; margin-bottom: 0.75rem; }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-google { background: #fff; color: #1a1a2e; }
    .btn-guest { background: rgba(99,102,241,0.15); color: #a5b4fc; border: 1px solid rgba(99,102,241,0.3); }
    .status { font-size: 0.78rem; font-family: ui-monospace, monospace;
      min-height: 1.5rem; color: rgba(255,255,255,0.5); margin-top: 1rem; }
    .status.error { color: #f87171; } .status.success { color: #34d399; }
    hr { border: none; border-top: 1px solid rgba(255,255,255,0.06); margin: 1.25rem 0; }
  </style>
  <script type="module">
    import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.0.0/firebase-app.js';
    import { getAuth, GoogleAuthProvider, signInWithPopup, signInAnonymously }
      from 'https://www.gstatic.com/firebasejs/11.0.0/firebase-auth.js';
    const CONFIG = ${configJson};
    const CODE = '${safeCode}', STATE = '${safeState}';
    const auth = getAuth(initializeApp(CONFIG));
    const setS = (m, c='') => { const e=document.getElementById('s'); e.textContent=m; e.className='status '+c; };
    const dis = v => { document.getElementById('bg').disabled=v; document.getElementById('gg').disabled=v; };
    async function exchange(tok) {
      setS('Connecting to LOHZ...');
      const r = await fetch('/api/auth/desktop-exchange', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({code:CODE,state:STATE,idToken:tok})
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error ?? 'Exchange failed');
    }
    document.getElementById('gg').onclick = async () => {
      dis(true); setS('Opening Google sign-in...');
      try {
        const r = await signInWithPopup(auth, new GoogleAuthProvider());
        await exchange(await r.user.getIdToken());
        setS('Authentication successful! Closing...', 'success');
        setTimeout(()=>window.close(), 2500);
      } catch(e) { setS('Sign-in failed: '+(e.message??'Unknown error'), 'error'); dis(false); }
    };
    document.getElementById('bg').onclick = async () => {
      dis(true); setS('Starting guest session...');
      try {
        const r = await signInAnonymously(auth);
        await exchange(await r.user.getIdToken());
        setS('Guest session started! Closing...', 'success');
        setTimeout(()=>window.close(), 2500);
      } catch(e) { setS('Guest sign-in failed: '+(e.message??'Unknown error'), 'error'); dis(false); }
    };
  </script>
</head>
<body>
  <div class="card">
    <div class="logo">LOHZ</div>
    <div class="sub">COGNITIVE DESKTOP ASSISTANT</div>
    <h2>Sign in to LOHZ</h2>
    <p>Your data is isolated to your account and never shared between users.</p>
    <button id="gg" class="btn btn-google">
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
        <path d="M17.64 9.2a10.37 10.37 0 0 0-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z" fill="#4285F4"/>
        <path d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.91-2.26c-.81.54-1.84.86-3.05.86-2.34 0-4.33-1.58-5.04-3.71H.96v2.33A9 9 0 0 0 9 18Z" fill="#34A853"/>
        <path d="M3.96 10.71A5.41 5.41 0 0 1 3.68 9c0-.59.1-1.17.28-1.71V4.96H.96A9 9 0 0 0 0 9c0 1.45.35 2.82.96 4.04l3-2.33Z" fill="#FBBC05"/>
        <path d="M9 3.58c1.32 0 2.51.45 3.44 1.34l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.96l3 2.33C4.67 5.16 6.66 3.58 9 3.58Z" fill="#EA4335"/>
      </svg>
      Sign in with Google
    </button>
    <hr />
    <button id="bg" class="btn btn-guest">Continue as Guest</button>
    <div id="s" class="status">Ready to authenticate.</div>
  </div>
</body>
</html>`;
}
