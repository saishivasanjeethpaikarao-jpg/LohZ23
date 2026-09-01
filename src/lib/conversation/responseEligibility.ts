import type { ConversationMode, SpeakerTurn } from "./types";

export type ResponseDecision =
  | { action: "respond"; reason: string }
  | { action: "clarify"; reason: string; response: string }
  | { action: "remain_silent"; reason: string };

const DIRECT_ADDRESS = /(?:^|\b)(?:hey\s+)?lohz\b[\s,:!?-]*/i;
const ASSISTANT_FOLLOWUP = /\b(?:what do you think|your thoughts|can you help|could you help|tell us|explain to us)\b/i;
const QUESTION = /\?\s*$|^(?:what|why|when|where|who|how|can|could|would|should|do|does|is|are)\b/i;

export function isExplicitlyAddressedToLohz(text: string): boolean {
  return DIRECT_ADDRESS.test(String(text));
}

/** Deterministic response gate. It never grants tool authorization. */
export function decideResponseEligibility(
  mode: ConversationMode,
  turn: Pick<SpeakerTurn, "text" | "speakerRole" | "overlapDetected" | "addressedToLohz">,
  recentTurns: ReadonlyArray<Pick<SpeakerTurn, "speakerRole" | "text">> = []
): ResponseDecision {
  if (turn.overlapDetected) {
    return {
      action: "clarify",
      reason: "overlapping_speech",
      response: "I caught more than one person at once—could you repeat that last part?",
    };
  }
  if (mode === "single_user") return { action: "respond", reason: "single_user_compatibility" };
  if (turn.addressedToLohz === true || isExplicitlyAddressedToLohz(turn.text)) {
    return { action: "respond", reason: "explicit_address" };
  }
  if (ASSISTANT_FOLLOWUP.test(turn.text)) return { action: "respond", reason: "contextual_address" };

  const prior = recentTurns.at(-1);
  if (turn.speakerRole !== "primary_user" && prior?.speakerRole === "primary_user" && QUESTION.test(prior.text)) {
    return { action: "remain_silent", reason: "participant_answering_primary_user" };
  }
  if (turn.speakerRole !== "primary_user") {
    return { action: "remain_silent", reason: "participant_not_addressing_lohz" };
  }
  if (QUESTION.test(turn.text)) {
    return {
      action: "clarify",
      reason: "ambiguous_primary_question",
      response: "Are you asking me, or were you discussing that with the group?",
    };
  }
  return { action: "remain_silent", reason: "group_conversation_not_addressed" };
}

