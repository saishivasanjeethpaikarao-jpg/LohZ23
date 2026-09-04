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
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!auth) {
      setLoading(false);
      return;
    }
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      // Check if this is a transition from an anonymous guest user to a permanent user
      const prevGuestUid = localStorage.getItem("lohz_guest_session_uid");
      if (firebaseUser && !firebaseUser.isAnonymous && prevGuestUid && prevGuestUid !== firebaseUser.uid) {
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
      } else if (firebaseUser?.isAnonymous) {
        localStorage.setItem("lohz_guest_session_uid", firebaseUser.uid);
      }

      setUser(firebaseUser);
      setLoading(false);
    });

    // Listen for lohz://auth/callback handoffs from desktop main process
    let unlistenProtocol: (() => void) | undefined;
    if (isDesktop && window.lohzDesktop?.onAuthProtocolCallback) {
      unlistenProtocol = window.lohzDesktop.onAuthProtocolCallback(async (payload) => {
        if (!auth) return;
        if (payload.token) {
          try {
            // Sign in with the custom token or credentials received
            await signInWithCustomToken(auth, payload.token);
          } catch {
            // Direct ID token or already logged in
          }
        }
      });
    }

    return () => {
      unsubscribe();
      unlistenProtocol?.();
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
    if (!auth) return;
    await firebaseSignOut(auth);
    // Client state cleared by callers (App.tsx resets memories/transcripts etc.)
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

