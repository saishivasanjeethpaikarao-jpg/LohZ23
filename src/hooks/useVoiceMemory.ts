import { useEffect, useRef, useState, useCallback } from "react";
import { MemoryCategory } from "../lib/memoryTypes";

interface UseVoiceMemoryOptions {
  userCaption: string;
  onAddMemory: (category: MemoryCategory, text: string) => Promise<void> | void;
  debounceMs?: number;
}

export interface AutoCapturedMemory {
  id: string;
  category: MemoryCategory;
  text: string;
  rawTrigger: string;
  timestamp: number;
}

/**
 * Intelligent categorization helper based on conversational context clues
 */
function inferCategory(text: string): MemoryCategory {
  const lower = text.toLowerCase();
  
  if (
    lower.includes("prefer") || 
    lower.includes("favorite") || 
    lower.includes("favourite") || 
    lower.includes("like") || 
    lower.includes("love") || 
    lower.includes("hate") || 
    lower.includes("dislike") ||
    lower.includes("theme") ||
    lower.includes("color") ||
    lower.includes("taste")
  ) {
    return "preference";
  }

  if (
    lower.includes("project") || 
    lower.includes("building") || 
    lower.includes("app") || 
    lower.includes("code") || 
    lower.includes("coding") || 
    lower.includes("program") || 
    lower.includes("startup") || 
    lower.includes("website") ||
    lower.includes("working on") ||
    lower.includes("repo") ||
    lower.includes("system")
  ) {
    return "project";
  }

  if (
    lower.includes("goal") || 
    lower.includes("aim") || 
    lower.includes("plan to") || 
    lower.includes("aspire") || 
    lower.includes("want to achieve") || 
    lower.includes("target") || 
    lower.includes("resolution")
  ) {
    return "goal";
  }

  if (
    lower.includes("friend") || 
    lower.includes("sister") || 
    lower.includes("brother") || 
    lower.includes("mother") || 
    lower.includes("father") || 
    lower.includes("mom") || 
    lower.includes("dad") || 
    lower.includes("wife") || 
    lower.includes("husband") || 
    lower.includes("colleague") || 
    lower.includes("partner") || 
    lower.includes("pet") || 
    lower.includes("dog") || 
    lower.includes("cat")
  ) {
    return "relationship";
  }

  if (
    lower.includes("feel") || 
    lower.includes("feeling") || 
    lower.includes("mood") || 
    lower.includes("anxious") || 
    lower.includes("excited") || 
    lower.includes("happy") || 
    lower.includes("stressed") || 
    lower.includes("overwhelmed") || 
    lower.includes("proud")
  ) {
    return "emotional";
  }

  if (
    lower.includes("every day") || 
    lower.includes("daily") || 
    lower.includes("routine") || 
    lower.includes("habit") || 
    lower.includes("usually") || 
    lower.includes("always") || 
    lower.includes("morning") || 
    lower.includes("night")
  ) {
    return "behavior";
  }

  return "identity";
}

/**
 * Clean up extracted memory snippet
 */
function cleanMemoryContent(raw: string): string {
  let cleaned = raw.trim();
  
  // Remove leading colons, dashes, quotes, and filler connectors
  cleaned = cleaned.replace(/^[:\s\-—"']+/g, "");
  cleaned = cleaned.replace(/^that\s+/i, "");
  cleaned = cleaned.replace(/^to\s+/i, "");
  cleaned = cleaned.replace(/["']+$/g, "");
  cleaned = cleaned.trim();

  // If text is in first person ("I am...", "My name is..."), format cleanly or keep clear
  if (cleaned.length > 0) {
    // Capitalize first character
    cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
    // Add terminating period if missing
    if (!/[.!?]$/.test(cleaned)) {
      cleaned += ".";
    }
  }

  return cleaned;
}

/**
 * useVoiceMemory Hook
 * Listens for triggers like "LOHZ, remember this" in live transcriptions and automatically
 * calls the addMemory handler with extracted content.
 */
export function useVoiceMemory({
  userCaption,
  onAddMemory,
  debounceMs = 600
}: UseVoiceMemoryOptions) {
  const [lastCaptured, setLastCaptured] = useState<AutoCapturedMemory | null>(null);
  const processedCaptionsRef = useRef<Set<string>>(new Set());
  const recentUtterancesRef = useRef<string[]>([]);
  const timeoutRef = useRef<any>(null);

  // Trigger patterns
  const TRIGGER_REGEXES = [
    /lohz[,\s]+(?:please\s+)?remember\s+(?:this|that)[:\s]*(.*)/i,
    /lohz[,\s]+(?:please\s+)?save\s+(?:this\s+)?(?:to\s+memory|memory)[:\s]*(.*)/i,
    /lohz[,\s]+(?:please\s+)?make\s+(?:a\s+)?note\s+(?:that|of)[:\s]*(.*)/i,
    /lohz[,\s]+(?:please\s+)?don'?t\s+forget\s+(?:that|this)[:\s]*(.*)/i,
    /remember\s+this[:\s]+(.*)/i,
    /remember\s+that[:\s]+(.*)/i,
    /note\s+this\s+down[:\s]+(.*)/i,
  ];

  // Keep track of recent utterance segments to support multi-part speech
  useEffect(() => {
    if (userCaption && userCaption.trim().length > 0) {
      const trimmed = userCaption.trim();
      const list = recentUtterancesRef.current;
      if (list[list.length - 1] !== trimmed) {
        list.push(trimmed);
        if (list.length > 5) list.shift();
      }
    }
  }, [userCaption]);

  const processTranscription = useCallback((text: string) => {
    if (!text || text.trim().length < 4) return;
    const trimmed = text.trim();

    // Check if already processed this exact phrase
    if (processedCaptionsRef.current.has(trimmed)) {
      return;
    }

    let matchedTrigger: string | null = null;
    let extractedContent: string | null = null;

    for (const regex of TRIGGER_REGEXES) {
      const match = trimmed.match(regex);
      if (match) {
        matchedTrigger = match[0];
        extractedContent = match[1] || "";
        break;
      }
    }

    if (matchedTrigger !== null) {
      let finalContent = cleanMemoryContent(extractedContent || "");

      // If user said just "LOHZ, remember this" with no trailing text, check the prior utterance
      if (finalContent.length < 3) {
        const history = recentUtterancesRef.current;
        if (history.length >= 2) {
          const prior = history[history.length - 2];
          if (prior && prior.length > 5 && !prior.toLowerCase().includes("remember")) {
            finalContent = cleanMemoryContent(prior);
          }
        }
      }

      // If still empty or too short, use the full trimmed text without the word "remember this"
      if (finalContent.length < 3) {
        finalContent = cleanMemoryContent(
          trimmed.replace(/lohz/gi, "").replace(/remember\s+(?:this|that)/gi, "")
        );
      }

      if (finalContent && finalContent.length >= 3) {
        processedCaptionsRef.current.add(trimmed);
        
        // Prevent unbounded memory growth in ref set
        if (processedCaptionsRef.current.size > 100) {
          processedCaptionsRef.current.clear();
          processedCaptionsRef.current.add(trimmed);
        }

        const category = inferCategory(finalContent);
        console.log(`[useVoiceMemory] Auto-captured voice memory: [${category}] "${finalContent}" from trigger: "${matchedTrigger}"`);

        const capturedEvent: AutoCapturedMemory = {
          id: Math.random().toString(36).substring(2, 9),
          category,
          text: finalContent,
          rawTrigger: matchedTrigger,
          timestamp: Date.now()
        };

        setLastCaptured(capturedEvent);
        onAddMemory(category, finalContent);

        // Auto-clear notification toast after 5 seconds
        setTimeout(() => {
          setLastCaptured((curr) => (curr?.id === capturedEvent.id ? null : curr));
        }, 5000);
      }
    }
  }, [onAddMemory]);

  useEffect(() => {
    if (!userCaption) return;

    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }

    timeoutRef.current = setTimeout(() => {
      processTranscription(userCaption);
    }, debounceMs);

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, [userCaption, debounceMs, processTranscription]);

  const clearNotification = useCallback(() => {
    setLastCaptured(null);
  }, []);

  return {
    lastCaptured,
    clearNotification,
    processTranscription
  };
}
