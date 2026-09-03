import React, { useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { LogIn, User, Sparkles, Shield, X, ArrowRight, CheckCircle2, Lock } from "lucide-react";
import { useAuth } from "../contexts/AuthContext";

interface LoginModalProps {
  isOpen: boolean;
  onClose?: () => void;
  canDismiss?: boolean;
}

export const LoginModal: React.FC<LoginModalProps> = ({
  isOpen,
  onClose,
  canDismiss = true,
}) => {
  const { user, signInWithGoogle, signInAsGuest } = useAuth();
  const [loadingAction, setLoadingAction] = useState<"google" | "guest" | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleGoogleSignIn = async () => {
    setLoadingAction("google");
    setErrorMessage(null);
    try {
      await signInWithGoogle();
      if (onClose) onClose();
    } catch (err: any) {
      setErrorMessage(err?.message || "Google sign-in could not be completed.");
    } finally {
      setLoadingAction(null);
    }
  };

  const handleGuestSignIn = async () => {
    setLoadingAction("guest");
    setErrorMessage(null);
    try {
      await signInAsGuest();
      if (onClose) onClose();
    } catch (err: any) {
      setErrorMessage(err?.message || "Guest session initialization failed.");
    } finally {
      setLoadingAction(null);
    }
  };

  return (
    <AnimatePresence>
      <motion.div
        key="login-modal-overlay"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6"
      >
        {/* Backdrop */}
        <div
          onClick={canDismiss && onClose ? onClose : undefined}
          className="absolute inset-0 bg-[#020208]/80 backdrop-blur-[16px]"
        />

        {/* Dynamic ambient background glow */}
        <div className="pointer-events-none absolute top-1/4 left-1/4 w-[450px] h-[450px] bg-purple-900/20 rounded-full blur-[140px]" />
        <div className="pointer-events-none absolute bottom-1/4 right-1/4 w-[500px] h-[500px] bg-cyan-900/20 rounded-full blur-[160px]" />

        {/* Modal Card */}
        <motion.div
          key="login-modal-card"
          initial={{ opacity: 0, y: 24, scale: 0.95 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 20, scale: 0.95 }}
          transition={{ type: "spring", stiffness: 350, damping: 28 }}
          className="relative w-full max-w-[460px] overflow-hidden rounded-[24px] border border-white/10 bg-[#090a14]/95 p-8 shadow-[0_0_0_1px_rgba(255,255,255,0.08),0_24px_80px_rgba(0,0,0,0.8),0_0_50px_rgba(99,102,241,0.2)] text-white backdrop-blur-2xl"
        >
          {/* Close button if dismissible */}
          {canDismiss && onClose && (
            <button
              onClick={onClose}
              className="absolute top-5 right-5 p-2 rounded-xl border border-white/10 bg-white/[0.04] text-white/50 hover:text-white hover:bg-white/[0.08] transition cursor-pointer"
              aria-label="Close"
            >
              <X size={15} />
            </button>
          )}

          {/* Logo & Emblem Header */}
          <div className="flex flex-col items-center text-center mb-7">
            <motion.div
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ delay: 0.1, type: "spring", stiffness: 300, damping: 20 }}
              className="relative mb-4 group"
            >
              <div className="w-20 h-20 rounded-2xl bg-black border border-white/15 p-2.5 flex items-center justify-center shadow-2xl overflow-hidden">
                <img
                  src="/app-logo.png"
                  alt="LOHZ23 Logo"
                  className="w-full h-full object-contain"
                />
              </div>
              <div className="absolute -inset-1 rounded-2xl bg-gradient-to-r from-purple-500/30 to-cyan-500/30 blur-sm -z-10 group-hover:opacity-100 opacity-60 transition" />
            </motion.div>

            <span className="text-[10px] font-mono tracking-[0.35em] text-white/40 uppercase">
              COGNITIVE DESKTOP ASSISTANT
            </span>
            <h2 className="text-[22px] font-bold tracking-tight text-white mt-1">
              Welcome to LOHZ23
            </h2>
            <p className="text-[12px] font-mono text-white/50 mt-1 max-w-[320px] leading-relaxed">
              Sign in to enable persistent cognitive memory, vault credentials & personal AI assistance.
            </p>
          </div>

          {/* Error Banner if any */}
          {errorMessage && (
            <motion.div
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              className="mb-5 p-3 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-300 text-xs font-mono"
            >
              {errorMessage}
            </motion.div>
          )}

          {/* Value Highlights */}
          <div className="grid grid-cols-2 gap-2 mb-6 text-[11px] font-mono text-white/60">
            <div className="flex items-center gap-1.5 p-2 rounded-xl bg-white/[0.03] border border-white/5">
              <Shield size={13} className="text-cyan-400 shrink-0" />
              <span>Isolated Vault</span>
            </div>
            <div className="flex items-center gap-1.5 p-2 rounded-xl bg-white/[0.03] border border-white/5">
              <Sparkles size={13} className="text-purple-400 shrink-0" />
              <span>Grounded Recalls</span>
            </div>
          </div>

          {/* Action Buttons */}
          <div className="space-y-2.5">
            <motion.button
              whileHover={{ scale: 1.015 }}
              whileTap={{ scale: 0.985 }}
              disabled={loadingAction !== null}
              onClick={handleGoogleSignIn}
              className="w-full h-12 rounded-xl bg-white hover:bg-white/95 text-[#0a0a14] font-semibold text-xs tracking-wider uppercase flex items-center justify-center gap-3 transition cursor-pointer shadow-lg shadow-white/5 disabled:opacity-50"
            >
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                <path d="M17.64 9.2a10.37 10.37 0 0 0-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z" fill="#4285F4"/>
                <path d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.91-2.26c-.81.54-1.84.86-3.05.86-2.34 0-4.33-1.58-5.04-3.71H.96v2.33A9 9 0 0 0 9 18Z" fill="#34A853"/>
                <path d="M3.96 10.71A5.41 5.41 0 0 1 3.68 9c0-.59.1-1.17.28-1.71V4.96H.96A9 9 0 0 0 0 9c0 1.45.35 2.82.96 4.04l3-2.33Z" fill="#FBBC05"/>
                <path d="M9 3.58c1.32 0 2.51.45 3.44 1.34l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.96l3 2.33C4.67 5.16 6.66 3.58 9 3.58Z" fill="#EA4335"/>
              </svg>
              <span>{loadingAction === "google" ? "Authenticating..." : "Continue with Google"}</span>
            </motion.button>

            <motion.button
              whileHover={{ scale: 1.015 }}
              whileTap={{ scale: 0.985 }}
              disabled={loadingAction !== null}
              onClick={handleGuestSignIn}
              className="w-full h-11 rounded-xl border border-white/10 bg-white/[0.04] hover:bg-white/[0.08] text-white/80 hover:text-white font-mono text-[11px] tracking-wider uppercase flex items-center justify-center gap-2 transition cursor-pointer disabled:opacity-50"
            >
              <User size={14} className="text-white/60" />
              <span>{loadingAction === "guest" ? "Creating session..." : "Continue as Guest"}</span>
            </motion.button>
          </div>

          {/* Footer note */}
          <div className="mt-5 text-center">
            <p className="text-[10px] font-mono text-white/35 flex items-center justify-center gap-1.5">
              <Lock size={10} />
              <span>AES-256 local encrypted · Upgrade anytime</span>
            </p>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
};
