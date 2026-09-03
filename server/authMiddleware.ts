import { Request, Response, NextFunction } from "express";
import { cert, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import path from "path";
import fs from "fs";

let firebaseAdminInitialized = false;

const DEV_UID_HEADER = "x-lohz-dev-uid";

function developmentBypassEnabled(): boolean {
  return process.env.NODE_ENV !== "production" && process.env.LOHZ_ALLOW_INSECURE_DEV_AUTH === "1";
}

function safeDevelopmentUid(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const uid = value.trim();
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(uid)) return null;
  return uid;
}

export function initFirebaseAdmin(): boolean {
  if (firebaseAdminInitialized) return true;

  const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || "./firebase-service-account.json";
  const resolvedPath = path.resolve(serviceAccountPath);

  if (!fs.existsSync(resolvedPath)) {
    console.warn("[auth] Firebase service account is not configured; authenticated requests will fail closed");
    return false;
  }

  try {
    const serviceAccount = JSON.parse(fs.readFileSync(resolvedPath, "utf-8"));
    initializeApp({
      credential: cert(serviceAccount as any),
    });
    firebaseAdminInitialized = true;
    console.log("[auth] Firebase Admin SDK initialized");
    return true;
  } catch (err) {
    console.error("[auth] Failed to initialize Firebase Admin; authenticated requests will fail closed");
    return false;
  }
}

export interface AuthenticatedRequest extends Request {
  userId?: string;
}

async function authenticate(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
  available: boolean,
  verifier: (token: string) => Promise<string>,
  allowDevelopmentBypass: boolean
): Promise<void> {
  if (!available) {
    if (allowDevelopmentBypass) {
      const uid = safeDevelopmentUid(req.header(DEV_UID_HEADER));
      if (!uid) {
        res.status(401).json({ error: `Missing or invalid ${DEV_UID_HEADER} header` });
        return;
      }
      req.userId = uid;
      next();
      return;
    }
    res.status(503).json({ error: "Authentication service unavailable" });
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing or invalid Authorization header" });
    return;
  }

  const idToken = authHeader.split("Bearer ")[1];

  try {
    const uid = await verifier(idToken);
    if (!safeDevelopmentUid(uid)) throw new Error("invalid uid claim");
    req.userId = uid;
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

export function authMiddleware(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const available = initFirebaseAdmin();
  void authenticate(
    req, res, next, available,
    async (token) => (await getAuth().verifyIdToken(token)).uid,
    developmentBypassEnabled()
  );
}

/** Injectable verifier seam for integration tests and non-Firebase adapters. */
export function createVerifiedAuthMiddleware(verifier: (token: string) => Promise<string>) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    void authenticate(req, res, next, true, verifier, false);
  };
}

/** Verify Firebase token from a raw token string (used for WebSocket upgrade) */
export async function verifyToken(token: string): Promise<string | null> {
  initFirebaseAdmin();

  if (!firebaseAdminInitialized) {
    if (developmentBypassEnabled()) {
      const devUid = token.startsWith("dev:") ? safeDevelopmentUid(token.slice(4)) : null;
      return devUid;
    }
    return null;
  }

  try {
    const decoded = await getAuth().verifyIdToken(token);
    return decoded.uid;
  } catch {
    return null;
  }
}

/** Test-only state reset. It never changes Firebase's global app registry. */
export function resetAuthStateForTests(): void {
  firebaseAdminInitialized = false;
}
