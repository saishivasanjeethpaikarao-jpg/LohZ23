export type ThemeColor = "violet" | "crimson" | "emerald" | "celestial" | "gold" | "rose" | "charcoal";

export interface SentimentAnalysisResult {
  score: number; // -1.0 (very negative) to +1.0 (very positive)
  magnitude: number; // 0.0 to 1.0 (intensity)
  label: "positive" | "negative" | "neutral" | "affectionate" | "excited" | "contemplative";
  recommendedTheme: ThemeColor;
  reason: string;
}

// Sentiment lexicon with weights
const POSITIVE_WORDS: Record<string, number> = {
  great: 0.7, good: 0.5, awesome: 0.9, amazing: 0.95, love: 0.9,
  happy: 0.8, wonderful: 0.9, excellent: 0.85, fantastic: 0.95,
  brilliant: 0.8, beautiful: 0.75, perfect: 0.9, enjoy: 0.6,
  nice: 0.4, sweet: 0.7, pleased: 0.6, cute: 0.7,
  fun: 0.6, best: 0.8, yay: 0.8, cool: 0.5,
  thank: 0.5, thanks: 0.5, appreciate: 0.7, grateful: 0.8,
  excited: 0.85, thrilled: 0.9, win: 0.8, victorious: 0.85,
  glad: 0.6, super: 0.6, incredible: 0.9, splendid: 0.8,
  delightful: 0.8, charming: 0.75, lovely: 0.8, smiling: 0.6,
};

const AFFECTION_WORDS: Record<string, number> = {
  love: 0.9, sweet: 0.75, sweetheart: 0.85, darling: 0.85,
  cute: 0.8, adorable: 0.85, hug: 0.7, cherish: 0.8,
  miss: 0.5, romantic: 0.8, gentle: 0.6, caring: 0.7,
  fond: 0.6, warmth: 0.6, cozy: 0.7, comfort: 0.6,
};

const NEGATIVE_WORDS: Record<string, number> = {
  bad: -0.6, terrible: -0.9, awful: -0.9, hate: -0.85,
  sad: -0.6, unhappy: -0.7, angry: -0.8, furious: -0.95,
  horrible: -0.9, worst: -0.85, upset: -0.7, annoying: -0.65,
  broken: -0.6, hurt: -0.7, fail: -0.7, failed: -0.75,
  error: -0.5, bug: -0.4, painful: -0.8, sick: -0.6,
  tired: -0.4, stress: -0.7, stressed: -0.75, anxious: -0.7,
  depressed: -0.85, bored: -0.4, wrong: -0.5, lost: -0.5,
  worried: -0.6, scared: -0.7, afraid: -0.7, panic: -0.85,
};

const CALM_WORDS: Record<string, number> = {
  relax: 0.5, calm: 0.6, peaceful: 0.7, quiet: 0.4,
  serene: 0.8, breathe: 0.5, meditation: 0.6, chill: 0.5,
  tranquil: 0.7, harmony: 0.7, sleep: 0.4, rest: 0.4,
  soothing: 0.6, gentle: 0.5, balance: 0.5,
};

const DEEP_THOUGHT_WORDS: Record<string, number> = {
  think: 0.2, philosophy: 0.4, wonder: 0.4, question: 0.3,
  curious: 0.5, mysteries: 0.5, space: 0.4, universe: 0.5,
  quantum: 0.5, theory: 0.3, create: 0.5, invent: 0.6,
  analyze: 0.4, reason: 0.3, imagine: 0.5,
};

/**
 * Analyzes natural speech/text to calculate sentiment score and dynamically map to appropriate holographic theme
 */
export function analyzeSentiment(text: string): SentimentAnalysisResult {
  if (!text || text.trim().length === 0) {
    return {
      score: 0,
      magnitude: 0,
      label: "neutral",
      recommendedTheme: "charcoal",
      reason: "Neutral ambient baseline"
    };
  }

  const cleaned = text.toLowerCase().replace(/[^a-z0-9\s]/g, " ");
  const tokens = cleaned.split(/\s+/).filter(Boolean);

  if (tokens.length === 0) {
    return {
      score: 0,
      magnitude: 0,
      label: "neutral",
      recommendedTheme: "charcoal",
      reason: "Neutral ambient baseline"
    };
  }

  let totalScore = 0;
  let wordMatches = 0;
  let affectionScore = 0;
  let calmScore = 0;
  let deepThoughtScore = 0;
  let exclamationMultiplier = (text.match(/!/g) || []).length * 0.15;

  // Check word occurrences
  for (const token of tokens) {
    if (POSITIVE_WORDS[token]) {
      totalScore += POSITIVE_WORDS[token];
      wordMatches++;
    } else if (NEGATIVE_WORDS[token]) {
      totalScore += NEGATIVE_WORDS[token];
      wordMatches++;
    }

    if (AFFECTION_WORDS[token]) {
      affectionScore += AFFECTION_WORDS[token];
    }
    if (CALM_WORDS[token]) {
      calmScore += CALM_WORDS[token];
    }
    if (DEEP_THOUGHT_WORDS[token]) {
      deepThoughtScore += DEEP_THOUGHT_WORDS[token];
    }
  }

  // Normalize score between -1.0 and +1.0
  let normalizedScore = wordMatches > 0 ? totalScore / Math.max(1, Math.min(wordMatches, 4)) : 0;
  if (normalizedScore > 0) {
    normalizedScore = Math.min(1.0, normalizedScore + exclamationMultiplier);
  } else if (normalizedScore < 0) {
    normalizedScore = Math.max(-1.0, normalizedScore - exclamationMultiplier);
  }

  const magnitude = Math.min(1.0, Math.abs(normalizedScore) + (wordMatches * 0.15));

  // Determine emotional category and theme mapping
  if (affectionScore >= 0.7 || (normalizedScore > 0.3 && (cleaned.includes("love") || cleaned.includes("cute") || cleaned.includes("sweet")))) {
    return {
      score: Number(Math.max(0.4, normalizedScore).toFixed(2)),
      magnitude: Number(magnitude.toFixed(2)),
      label: "affectionate",
      recommendedTheme: "rose",
      reason: "Affectionate & Warm Tone Detected"
    };
  }

  if (normalizedScore >= 0.4 || (normalizedScore > 0.25 && exclamationMultiplier > 0)) {
    return {
      score: Number(normalizedScore.toFixed(2)),
      magnitude: Number(magnitude.toFixed(2)),
      label: "excited",
      recommendedTheme: "gold",
      reason: "High-energy Joy & Excitement Detected"
    };
  }

  if (calmScore >= 0.6 || (normalizedScore >= 0.15 && (cleaned.includes("relax") || cleaned.includes("peace") || cleaned.includes("chill")))) {
    return {
      score: Number(normalizedScore.toFixed(2)),
      magnitude: Number(magnitude.toFixed(2)),
      label: "positive",
      recommendedTheme: "emerald",
      reason: "Serene & Tranquil Tone Detected"
    };
  }

  if (deepThoughtScore >= 0.6 || (cleaned.includes("why") && cleaned.includes("think"))) {
    return {
      score: Number(normalizedScore.toFixed(2)),
      magnitude: Number(magnitude.toFixed(2)),
      label: "contemplative",
      recommendedTheme: "violet",
      reason: "Curious & Mystical Tone Detected"
    };
  }

  if (normalizedScore <= -0.35) {
    return {
      score: Number(normalizedScore.toFixed(2)),
      magnitude: Number(magnitude.toFixed(2)),
      label: "negative",
      recommendedTheme: "crimson",
      reason: "High Alert / Frustrated Tone Detected"
    };
  }

  if (normalizedScore < -0.1) {
    return {
      score: Number(normalizedScore.toFixed(2)),
      magnitude: Number(magnitude.toFixed(2)),
      label: "negative",
      recommendedTheme: "violet",
      reason: "Moody or Somber Tone Detected"
    };
  }

  if (normalizedScore > 0.1) {
    return {
      score: Number(normalizedScore.toFixed(2)),
      magnitude: Number(magnitude.toFixed(2)),
      label: "positive",
      recommendedTheme: "celestial",
      reason: "Pleasant & Clear Tone Detected"
    };
  }

  return {
    score: Number(normalizedScore.toFixed(2)),
    magnitude: Number(magnitude.toFixed(2)),
    label: "neutral",
    recommendedTheme: "charcoal",
    reason: "Balanced Ambient Baseline"
  };
}
