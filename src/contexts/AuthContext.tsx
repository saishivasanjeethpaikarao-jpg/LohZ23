import React, { createContext, useContext, useEffect, useState } from "react";
import {
  onAuthStateChanged,
  signInWithPopup,
  signInAnonymously,
  signInWithCustomToken,
  linkWithPopup,
  signOut as firebaseSignOut,
  User,
} from "firebase/auth";
import { auth, googleProvider, isFirebaseEnabled } from "../lib/firebase";

/** Declared by desktop/preload.ts via contextBridge */
declare global {
  interface Window {
    lohzDesktop?: {
      platform: string;
      version: string;
      capabilities: () => Promise<unknown>;
      backupData: () => Promise<unknown>;
      restoreData: () => Promise<unknown>;
      updateStatus: () => Promise<unknown>;
      openAuth: () => Promise<{ ok: boolean; uid?: string; error?: string }>;
      onAuthProtocolCallback?: (callback: (payload: { token?: string; uid?: string; guest?: boolean; displayName?: string; email?: string }) => void) => () => void;
    };
  }
}

const isDesktop = typeof window !== "undefined" && !!window.lohzDesktop;

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  isGuest: boolean;
  signInWithGoogle: () => Promise<void>;
  signInAsGuest: () => Promise<void>;
  upgradeGuestAccount: () => Promise<void>;
  signOut: () => Promise<void>;
  getIdToken: () => Promise<string | null>;
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  loading: true,
  isGuest: false,
  signInWithGoogle: async () => {},
  signInAsGuest: async () => {},
  upgradeGuestAccount: async () => {},
  signOut: async () => {},
  getIdToken: async () => null,
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(() => {
    // Phase 49: Instant session restoration from localStorage for desktop & web
    if (typeof window !== "undefined") {
      try {
        const cached = localStorage.getItem("lohz_authenticated_user");
        if (cached) {
          const parsed = JSON.parse(cached);
          if (parsed?.uid) {
            return {
              uid: parsed.uid,
              email: parsed.email || null,
              displayName: parsed.displayName || (parsed.email ? parsed.email.split("@")[0] : "LOHZ User"),
              photoURL: parsed.photoURL || null,
              isAnonymous: !!parsed.isAnonymous,
              emailVerified: true,
              phoneNumber: null,
              tenantId: null,
              providerId: "google.com",
              metadata: {} as any,
              providerData: [],
              refreshToken: "",
              delete: async () => {},
              getIdToken: async () => parsed.token || "",
              getIdTokenResult: async () => ({
                token: parsed.token || "",
                claims: {},
                authTime: new Date().toISOString(),
                issuedAtTime: new Date().toISOString(),
                expirationTime: new Date(Date.now() + 3600_000).toISOString(),
                signInProvider: parsed.isAnonymous ? "anonymous" : "google.com",
              } as any),
              reload: async () => {},
              toJSON: () => parsed,
            } as unknown as User;
          }
        }
      } catch (err) {
        console.warn("[Auth] Failed to restore cached session:", err);
      }
    }
    return null;
  });

  const [loading, setLoading] = useState(!user);

  // Helper to apply authenticated payload from either lohz:// protocol or localhost loopback
  const applyAuthenticatedPayload = async (payload: {
    token?: string;
    uid?: string;
    guest?: boolean;
    displayName?: string;
    email?: string;
    photoURL?: string;
  }) => {
    if (!payload.token && !payload.uid) return;

    // Try custom token sign-in first if Firebase is configured
    if (auth && payload.token) {
      try {
        await signInWithCustomToken(auth, payload.token);
        return; // onAuthStateChanged will fire and set the user
      } catch {
        // Token was a Firebase ID token or standalone JWT — fallback to session synthesis
      }
    }

    const synthesizedUser: User = {
      uid: payload.uid || (payload.guest ? `guest_${Date.now()}` : "google-user"),
      email: payload.email || null,
      displayName: payload.displayName || (payload.guest ? "Guest User" : (payload.email ? payload.email.split("@")[0] : "LOHZ User")),
      photoURL: payload.photoURL || null,
      isAnonymous: !!payload.guest,
      emailVerified: true,
      phoneNumber: null,
      tenantId: null,
      providerId: payload.guest ? "anonymous" : "google.com",
      metadata: {} as any,
      providerData: [],
      refreshToken: "",
      delete: async () => {},
      getIdToken: async () => payload.token || "",
      getIdTokenResult: async () => ({
        token: payload.token || "",
        claims: {},
        authTime: new Date().toISOString(),
        issuedAtTime: new Date().toISOString(),
        expirationTime: new Date(Date.now() + 3600_000).toISOString(),
        signInProvider: payload.guest ? "anonymous" : "google.com",
      } as any),
      reload: async () => {},
      toJSON: () => ({ uid: payload.uid, email: payload.email, displayName: payload.displayName }),
    } as unknown as User;

    setUser(synthesizedUser);
    localStorage.setItem("lohz_authenticated_user", JSON.stringify({
      uid: synthesizedUser.uid,
      email: synthesizedUser.email,
      displayName: synthesizedUser.displayName,
      photoURL: synthesizedUser.photoURL,
      token: payload.token || "",
      isAnonymous: synthesizedUser.isAnonymous,
    }));
    setLoading(false);
  };

  useEffect(() => {
    let unsubscribe = () => {};

    if (auth) {
      unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
        if (firebaseUser) {
          const prevGuestUid = localStorage.getItem("lohz_guest_session_uid");
          if (!firebaseUser.isAnonymous && prevGuestUid && prevGuestUid !== firebaseUser.uid) {
            try {
              const token = await firebaseUser.getIdToken();
              await fetch("/api/auth/migrate-guest", {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                body: JSON.stringify({ guestUid: prevGuestUid }),
              });
              localStorage.removeItem("lohz_guest_session_uid");
            } catch (err) {
              console.warn("[Auth] Background guest data migration error:", err);
            }
          } else if (firebaseUser.isAnonymous) {
            localStorage.setItem("lohz_guest_session_uid", firebaseUser.uid);
          }

          setUser(firebaseUser);
          try {
            const idTok = await firebaseUser.getIdToken();
            localStorage.setItem("lohz_authenticated_user", JSON.stringify({
              uid: firebaseUser.uid,
              email: firebaseUser.email,
              displayName: firebaseUser.displayName,
              photoURL: firebaseUser.photoURL,
              token: idTok,
              isAnonymous: firebaseUser.isAnonymous,
            }));
          } catch {}
        }
        setLoading(false);
      });
    } else {
      setLoading(false);
    }

    // 1. Listen for lohz://auth/callback deep-link handoffs from desktop main process
    let unlistenProtocol: (() => void) | undefined;
    if (isDesktop && window.lohzDesktop?.onAuthProtocolCallback) {
      unlistenProtocol = window.lohzDesktop.onAuthProtocolCallback(async (payload) => {
        await applyAuthenticatedPayload(payload);
      });
    }

    // 2. Local loopback polling fallback: check if web browser sent credentials to local backend
    let loopbackInterval: NodeJS.Timeout | undefined;
    if (isDesktop) {
      loopbackInterval = setInterval(async () => {
        try {
          const res = await fetch("/api/auth/desktop-session");
          if (!res.ok) return;
          const data = await res.json();
          if (data.ok && data.session && (data.session.uid || data.session.token)) {
            await applyAuthenticatedPayload(data.session);
            await fetch("/api/auth/clear-desktop-session", { method: "POST" });
          }
        } catch {
          // Local server offline or busy
        }
      }, 1500);
    }

    return () => {
      unsubscribe();
      unlistenProtocol?.();
      if (loopbackInterval) clearInterval(loopbackInterval);
    };
  }, []);

  /**
   * Sign in with Google.
   * Desktop: opens the system browser via the secure IPC flow.
   * Web: uses signInWithPopup (standard Firebase approach).
   */
  const signInWithGoogle = async () => {
    if (isDesktop && window.lohzDesktop?.openAuth) {
      // Desktop: system-browser auth flow (opens Netlify Auth Hub / browser)
      const result = await window.lohzDesktop.openAuth();
      if (!result.ok) {
        throw new Error(result.error || "Desktop authentication failed");
      }
      // Browser redirected to lohz://auth/callback which handles sign in via onAuthProtocolCallback
      return;
    }

    if (!auth) throw new Error("Firebase not configured");
    // Web: standard popup flow
    await signInWithPopup(auth, googleProvider);
  };

  /**
   * Sign in as guest (anonymous session).
   * Desktop: uses the server-issued custom token or anonymous session.
   * Web: uses signInAnonymously directly.
   */
  const signInAsGuest = async () => {
    if (isDesktop) {
      // Desktop: request a guest custom token from the backend
      try {
        const res = await fetch("/api/auth/guest-session", { method: "POST" });
        const data = await res.json();
        if (data.ok && data.customToken && auth) {
          await signInWithCustomToken(auth, data.customToken);
          return;
        }
      } catch (e) {
        console.warn("[Auth] Backend guest-session error:", e);
      }

      if (auth) {
        await signInAnonymously(auth);
        return;
      }

      // If Firebase SDK is completely disabled, treat as local guest companion
      setUser({
        uid: "guest-local-session",
        isAnonymous: true,
        displayName: "Guest User",
        email: null,
        photoURL: null,
      } as any);
      return;
    }

    if (!auth) throw new Error("Firebase not configured");
    await signInAnonymously(auth);
  };

  /**
   * Upgrade a guest/anonymous account to a permanent Google account.
   * Preserves all user data (memories, preferences) under the same UID.
   */
  const upgradeGuestAccount = async () => {
    if (!auth || !user) throw new Error("No active session to upgrade");
    if (!user.isAnonymous) throw new Error("Account is already a permanent account");
    await linkWithPopup(user, googleProvider);
    // onAuthStateChanged fires with the updated user — no explicit state update needed
  };

  const signOut = async () => {
    localStorage.removeItem("lohz_authenticated_user");
    localStorage.removeItem("lohz_guest_session_uid");
    setUser(null);
    if (auth) {
      try {
        await firebaseSignOut(auth);
      } catch (err) {
        console.warn("[Auth] Firebase signout error:", err);
      }
    }
    if (isDesktop) {
      try {
        await fetch("/api/auth/clear-desktop-session", { method: "POST" });
      } catch {}
    }
  };

  const getIdToken = async (): Promise<string | null> => {
    if (!user) return null;
    return user.getIdToken();
  };

  const isGuest = user?.isAnonymous ?? false;

  return (
    <AuthContext.Provider value={{ user, loading, isGuest, signInWithGoogle, signInAsGuest, upgradeGuestAccount, signOut, getIdToken }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}

