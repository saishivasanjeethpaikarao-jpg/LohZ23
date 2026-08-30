/**
 * Phase 32 - Unified Cognitive Core public surface.
 */
export type {
  CognitiveAction,
  CognitiveDecision,
  CognitiveResult,
  FrameEvent,
  FrameGoal,
  FrameMemory,
  FrameProject,
  LohzCapabilitySnapshot,
  SituationFrame,
  TimeContext,
  VerificationStatus,
  WorldAssertionSource,
  RationaleMetadata,
} from "./types";
export { FRAME_LIMITS } from "./types";
export { createSituationFrame, buildTimeContext, isVoiceStyle, type FrameInput } from "./situationFrame";
export { ContextAssembler, type ContextProviders, type AssembledContext } from "./contextAssembler";
export {
  sanitizeDiagnostic,
  renderReasoningPrompt,
  checkToolClaims,
  checkExecutionTruthfulness,
  checkVerificationClaims,
  checkFrameReferences,
  validateModelProposal,
} from "./cognitiveGuards";
export { CognitiveCore, type CognitiveCoreDeps } from "./cognitiveCore";
