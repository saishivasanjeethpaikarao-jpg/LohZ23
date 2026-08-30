/**
 * Phase 27 — IntentRouter: deterministic-first classification (§2, §3).
 *
 * Zero async, zero network. Pattern table over normalized input with
 * confidence scoring; ambiguity detection for unresolvable referents.
 */
import {
  CONFIDENCE,
  INTENT_RISK,
  Intent,
  RouteEntities,
  RoutingResult,
  tierForIntent,
} from "./types";
import { matchable, normalizeInput } from "./normalize";
import {
  canonicalAppName,
  extractEntities,
  extractQuotedText,
} from "./entities";

interface Rule {
  intent: Intent;
  pattern: RegExp;
  /** Confidence assigned when the rule matches. */
  confidence: number;
}

const RULES: Rule[] = [
  // volume (before generic app rules; "set volume" isn't an app)
  { intent: "volume_set", pattern: /^(?:set|change|turn)\s+(?:the\s+)?volume\s+(?:to|up(?:\s+to)?|down(?:\s+to)?)/i, confidence: CONFIDENCE.exactCommand },
  { intent: "volume_get", pattern: /^(?:what(?:'s| is)\s+the\s+)?volume\b/i, confidence: CONFIDENCE.clearPattern },
  // screenshot
  { intent: "screenshot", pattern: /^take\s+(?:a\s+)?screenshot|^screenshot$/i, confidence: CONFIDENCE.exactCommand },
  // clipboard (write must preface read — 'copy "x" to clipboard' vs bare 'copy')
  { intent: "clipboard_write", pattern: /^(?:copy|write|save)\b.*\bto\s+(?:the\s+)?clipboard\b/i, confidence: CONFIDENCE.exactCommand },
  { intent: "clipboard_read", pattern: /^(?:read|what(?:'s| is)\s+in)\s+(?:the\s+)?clipboard|^copy\s*(?:this)?$|^paste$/i, confidence: CONFIDENCE.exactCommand },
  // system info
  { intent: "system_info", pattern: /^(?:system\s*info|system information|show system info)$/i, confidence: CONFIDENCE.exactCommand },
  // URL before open_app when a URL/domain is present
  { intent: "open_url", pattern: /^(?:open|go\s+to|visit|browse)\b/i, confidence: CONFIDENCE.clearPattern },
  // apps
  { intent: "open_app", pattern: /^(?:open|start|launch)\s+\S+/i, confidence: CONFIDENCE.exactCommand },
  { intent: "close_app", pattern: /^(?:close|kill|quit)\s+\S+/i, confidence: CONFIDENCE.exactCommand },
  { intent: "focus_app", pattern: /^focus\s+\S+|^switch\s+to\s+\S+/i, confidence: CONFIDENCE.exactCommand },
  // memory / context queries
  { intent: "memory_query", pattern: /\b(what\s+do\s+you\s+(?:remember|know)\s+about|do\s+you\s+remember|recall)\b/i, confidence: CONFIDENCE.clearPattern },
  { intent: "context_query", pattern: /\b(what\s+(?:was|am|were)\s+i\s+(?:working|doing)|current\s+project|where\s+were\s+we|what.*yesterday|status\s+of\s+.*)\b/i, confidence: CONFIDENCE.clearPattern },
  // autonomous
  { intent: "manage_goal", pattern: /\b(add|create|complete|finish|cancel)\s+(?:a\s+)?goal\b|\bmy\s+goals?\b/i, confidence: CONFIDENCE.clearPattern },
  { intent: "plan", pattern: /\b(plan|schedule|roadmap|break\s+down)\b.*\b(for|my|the)\b/i, confidence: CONFIDENCE.clearPattern },
  { intent: "execute_task", pattern: /\b(finish|set\s+everything\s+up|work\s+on)\b.*(while|i'm away|for me)\b/i, confidence: CONFIDENCE.clearPattern },
  // Goal-ish imperative catch-all — AFTER execute_task so "finish X while
  // I'm away" keeps its specific match; requires a substantial tail so
  // bare commands are never hijacked into tier3.
  { intent: "manage_goal", pattern: /^(?:finish|complete|set\s*up|setup|implement|build)\b.{6,}/i, confidence: CONFIDENCE.clearPattern },
  // reasoning
  { intent: "compare", pattern: /^(?:compare|versus|vs\.?)\b/i, confidence: CONFIDENCE.clearPattern },
  { intent: "summarize", pattern: /^(?:summarize|tl;?dr)\b/i, confidence: CONFIDENCE.clearPattern },
  { intent: "explain", pattern: /^(?:explain|how\s+does|what\s+is\s+a)\b/i, confidence: CONFIDENCE.clearPattern },
  { intent: "reason", pattern: /\bwhy\b|\bhelp me\b|\bfailing\b|\bdebug\b/i, confidence: CONFIDENCE.clearPattern },
];

/** Referent pronouns that cannot be resolved deterministically. */
const UNRESOLVED_REFERENT = /^\s*(?:it|that|this|them)\s*$/i;

export function classify(rawInput: string): RoutingResult {
  const normalized = normalizeInput(rawInput);
  const text = matchable(normalized);

  let best: { intent: Intent; confidence: number } | null = null;
  for (const rule of RULES) {
    if (rule.pattern.test(text)) {
      // First match in table order wins — table is priority-ordered.
      best = { intent: rule.intent, confidence: rule.confidence };
      break;
    }
  }

  const entities: RouteEntities = extractEntities(text);

  // URL refinement for open_url vs open_app
  if (best?.intent === "open_url") {
    if (!entities.url) {
      // "open github.com" handled by entity extractor; bare word → treat as app/url ambiguity
      const bare = text.replace(/^(?:open|go to|visit|browse)\s+/i, "").trim();
      if (/^[a-z0-9-]+\.[a-z]{2,}$/i.test(bare)) {
        entities.url = `https://${bare}`;
      } else if (bare && !UNRESOLVED_REFERENT.test(bare)) {
        best.intent = "open_app"; // no domain present → it's an app command
        entities.appName = canonicalAppName(bare.split(/\s+/)[0]);
      } else if (bare && UNRESOLVED_REFERENT.test(bare)) {
        // Pronoun referent ("open it") — must NOT guess an application (§7).
        best.intent = "open_app";
      }
    }
  }

  if (!best) {
    return {
      tier: tierForIntent("chat"),
      intent: "chat",
      confidence: 0.55,
      entities,
      requiresMemory: false,
      requiresContext: false,
      requiresReasoning: false,
      requiresPlanning: false,
      requiresTool: false,
      riskLevel: INTENT_RISK.chat,
    };
  }

  // Ambiguity gate: tool intents whose required entity is missing or a
  // bare pronoun must NOT guess (§7).
  let needsClarification: string | undefined;
  if (best.intent === "open_app" || best.intent === "close_app" || best.intent === "focus_app") {
    const target = text.replace(/^\s*(?:open|start|launch|close|kill|quit|focus|switch to)\s+/i, "").trim();
    if (!target || UNRESOLVED_REFERENT.test(target)) {
      needsClarification = `Which application should I ${best.intent === "open_app" ? "open" : best.intent === "close_app" ? "close" : "focus"}?`;
      if (entities.appName) needsClarification = undefined; // extractor saved us
      else best.confidence = Math.min(best.confidence, 0.5);
    } else if (!entities.appName) {
      entities.appName = canonicalAppName(target.split(/\s+/)[0]);
    }
  }
  if (best.intent === "clipboard_write") {
    const payload = extractQuotedText(text);
    if (payload) entities.text = payload;
    else {
      needsClarification = "What text should I copy to the clipboard?";
      best.confidence = Math.min(best.confidence, 0.5);
    }
  }
  if (best.intent === "volume_set" && entities.volumeLevel === undefined) {
    needsClarification = "What volume level?";
    best.confidence = Math.min(best.confidence, 0.5);
  }

  const result: RoutingResult = {
    tier: tierForIntent(best.intent),
    intent: best.intent,
    confidence: best.confidence,
    entities,
    requiresMemory: best.intent === "memory_query",
    requiresContext: best.intent === "context_query",
    requiresReasoning: ["reason", "explain", "compare", "summarize"].includes(best.intent),
    requiresPlanning: ["plan", "execute_task", "manage_goal"].includes(best.intent),
    requiresTool: tierForIntent(best.intent) === "tier0_direct",
    riskLevel: INTENT_RISK[best.intent],
  };
  if (needsClarification) result.needsClarification = needsClarification;
  return result;
}
