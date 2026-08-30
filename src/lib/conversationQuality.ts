export interface QualityCheck {
  passed: boolean;
  issues: string[];
  score: number;
}

export interface QualityContext {
  recentTurns: Array<{ role: string; content: string; timestamp: number }>;
  activeTopic: string | null;
  userEmotionalState: string;
}

export interface ConversationQualityConfig {
  maxRecentPhrases: number;
  repetitionOverlapThreshold: number;
  maxConsecutiveQuestions: number;
  maxQuestionsPerSession: number;
  minPhraseDiversity: number;
  fillerWords: string[];
  artificialFillers: string[];
  questionPatterns: RegExp[];
}

const DEFAULT_CONFIG: ConversationQualityConfig = {
  maxRecentPhrases: 20,
  repetitionOverlapThreshold: 0.6,
  maxConsecutiveQuestions: 2,
  maxQuestionsPerSession: 8,
  minPhraseDiversity: 0.6,
  fillerWords: [
    "um", "uh", "er", "ah", "like", "well", "so", "basically",
    "actually", "just", "you know", "i mean", "right", "okay so",
  ],
  artificialFillers: [
    "are you there",
    "how are you",
    "want to talk",
    "just checking in",
    "hey!",
    "hi there!",
    "hello!",
    "quick question",
    "got a minute",
    "are you still there",
    "you still there",
  ],
  questionPatterns: [
    /\?$/,
    /\bhow\b/i,
    /\bwhat\b/i,
    /\bwhy\b/i,
    /\bwhen\b/i,
    /\bwhere\b/i,
    /\bcan you\b/i,
    /\bcould you\b/i,
    /\bwould you\b/i,
  ],
};

export class ConversationQualityChecker {
  private recentPhrases: Array<{ text: string; timestamp: number }> = [];
  private phraseFrequency: Map<string, number> = new Map();
  private consecutiveQuestions: number = 0;
  private questionsThisSession: number = 0;
  private totalPhrasesSpoken: number = 0;
  private config: ConversationQualityConfig;

  constructor(config?: Partial<ConversationQualityConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  checkQuality(proposedText: string, context: QualityContext): QualityCheck {
    const issues: string[] = [];

    const repetitionIssues = this.checkRepetition(proposedText);
    issues.push(...repetitionIssues);

    const fillerIssues = this.checkFiller(proposedText);
    issues.push(...fillerIssues);

    const questionIssues = this.checkQuestionLimit(proposedText);
    issues.push(...questionIssues);

    const artificialIssues = this.checkArtificialFiller(proposedText);
    issues.push(...artificialIssues);

    const diversityIssues = this.checkDiversity();
    issues.push(...diversityIssues);

    const score = this.calculateScore(issues);

    return {
      passed: issues.length === 0,
      issues,
      score,
    };
  }

  recordSpoken(text: string): void {
    const now = Date.now();
    this.recentPhrases.push({ text, timestamp: now });
    if (this.recentPhrases.length > this.config.maxRecentPhrases) {
      this.recentPhrases.shift();
    }

    const normalized = this.normalizeText(text);
    this.phraseFrequency.set(
      normalized,
      (this.phraseFrequency.get(normalized) ?? 0) + 1
    );

    this.totalPhrasesSpoken++;

    if (this.isQuestion(text)) {
      this.consecutiveQuestions++;
      this.questionsThisSession++;
    } else {
      this.consecutiveQuestions = 0;
    }
  }

  getPhraseDiversity(): number {
    if (this.totalPhrasesSpoken === 0) return 1;
    return this.phraseFrequency.size / this.totalPhrasesSpoken;
  }

  getConsecutiveQuestions(): number {
    return this.consecutiveQuestions;
  }

  getQuestionsThisSession(): number {
    return this.questionsThisSession;
  }

  private checkRepetition(text: string): string[] {
    const issues: string[] = [];
    const words = this.extractWords(text);

    for (const phrase of this.recentPhrases) {
      const recentWords = this.extractWords(phrase.text);
      const overlap = this.calculateOverlap(words, recentWords);
      if (overlap >= this.config.repetitionOverlapThreshold) {
        issues.push(
          `Repetition detected: ${Math.round(overlap * 100)}% overlap with recent phrase`
        );
        break;
      }
    }

    return issues;
  }

  private checkFiller(text: string): string[] {
    const issues: string[] = [];
    const lower = text.toLowerCase();
    const words = lower.split(/\s+/);

    for (const filler of this.config.fillerWords) {
      if (words.includes(filler) || lower.includes(filler)) {
        issues.push(`Filler word detected: "${filler}"`);
      }
    }

    return issues;
  }

  private checkQuestionLimit(text: string): string[] {
    const issues: string[] = [];

    if (this.isQuestion(text)) {
      if (this.consecutiveQuestions >= this.config.maxConsecutiveQuestions) {
        issues.push(
          `Too many consecutive questions (${this.consecutiveQuestions})`
        );
      }
      if (this.questionsThisSession >= this.config.maxQuestionsPerSession) {
        issues.push(
          `Session question limit reached (${this.questionsThisSession})`
        );
      }
    }

    return issues;
  }

  private checkArtificialFiller(text: string): string[] {
    const issues: string[] = [];
    const lower = text.toLowerCase().trim();

    for (const filler of this.config.artificialFillers) {
      if (lower === filler || lower.startsWith(filler)) {
        issues.push(`Artificial filler detected: "${filler}"`);
        break;
      }
    }

    return issues;
  }

  private checkDiversity(): string[] {
    const issues: string[] = [];
    const diversity = this.getPhraseDiversity();
    if (diversity < this.config.minPhraseDiversity && this.totalPhrasesSpoken > 5) {
      issues.push(
        `Low phrase diversity: ${diversity.toFixed(2)} (min: ${this.config.minPhraseDiversity})`
      );
    }
    return issues;
  }

  private calculateScore(issues: string[]): number {
    let score = 1.0;
    for (const issue of issues) {
      if (issue.startsWith("Repetition")) score -= 0.3;
      else if (issue.startsWith("Filler")) score -= 0.1;
      else if (issue.startsWith("Too many")) score -= 0.25;
      else if (issue.startsWith("Session question")) score -= 0.4;
      else if (issue.startsWith("Artificial")) score -= 0.35;
      else if (issue.startsWith("Low phrase")) score -= 0.15;
    }
    return Math.max(0, Math.min(1, score));
  }

  private isQuestion(text: string): boolean {
    return this.config.questionPatterns.some((p) => p.test(text.trim()));
  }

  private normalizeText(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^\w\s]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  private extractWords(text: string): string[] {
    return this.normalizeText(text).split(" ").filter(Boolean);
  }

  private calculateOverlap(words1: string[], words2: string[]): number {
    if (words1.length === 0 || words2.length === 0) return 0;
    const set2 = new Set(words2);
    const overlap = words1.filter((w) => set2.has(w)).length;
    return overlap / Math.max(words1.length, words2.length);
  }

  reset(): void {
    this.recentPhrases = [];
    this.phraseFrequency.clear();
    this.consecutiveQuestions = 0;
    this.questionsThisSession = 0;
    this.totalPhrasesSpoken = 0;
  }
}
