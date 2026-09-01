import { 
  Memory, 
  MemoryLayer, 
  MemoryCategory, 
  MemoryMetadata, 
  ConsolidationCandidate, 
  ExtractedFact,
  ConversationTurn,
  MemoryTransaction 
} from "./memoryTypes";

export interface ConsolidationConfig {
  minImportanceThreshold: number;
  minConfidenceThreshold: number;
  duplicationSimilarityThreshold: number;
  contradictionConfidenceThreshold: number;
  maxCandidatesPerConversation: number;
}

export const DEFAULT_CONSOLIDATION_CONFIG: ConsolidationConfig = {
  minImportanceThreshold: 0.4,
  minConfidenceThreshold: 0.5,
  duplicationSimilarityThreshold: 0.85,
  contradictionConfidenceThreshold: 0.7,
  maxCandidatesPerConversation: 10,
};

export class MemoryConsolidation {
  private config: ConsolidationConfig;
  private consolidationHistory: ConsolidationCandidate[] = [];

  constructor(config: Partial<ConsolidationConfig> = {}) {
    this.config = { ...DEFAULT_CONSOLIDATION_CONFIG, ...config };
  }

  async processConversation(
    conversation: ConversationTurn[],
    existingMemories: Memory[],
    userId: string
  ): Promise<MemoryTransaction[]> {
    const candidate = await this.extractCandidates(conversation, existingMemories, userId);
    this.consolidationHistory.push(candidate);
    
    if (this.consolidationHistory.length > 100) {
      this.consolidationHistory.shift();
    }

    return this.generateTransactions(candidate, existingMemories, userId);
  }

  private async extractCandidates(
    conversation: ConversationTurn[],
    existingMemories: Memory[],
    userId: string
  ): Promise<ConsolidationCandidate> {
    const extractedFacts: ExtractedFact[] = [];

    for (const turn of conversation) {
      if (turn.role !== "user") continue;
      
      const facts = this.extractFactsFromTurn(turn, existingMemories, userId);
      extractedFacts.push(...facts);
    }

    const filtered = extractedFacts
      .filter(f => f.importance >= this.config.minImportanceThreshold)
      .filter(f => f.confidence >= this.config.minConfidenceThreshold)
      .slice(0, this.config.maxCandidatesPerConversation);

    return {
      sourceConversation: conversation,
      extractedFacts: filtered,
      timestamp: Date.now(),
    };
  }

  private extractFactsFromTurn(
    turn: ConversationTurn,
    existingMemories: Memory[],
    userId: string
  ): ExtractedFact[] {
    const facts: ExtractedFact[] = [];
    const content = turn.content.toLowerCase();

    // Identity facts
    const identityPatterns = [
      { pattern: /my name is (\w+)/, category: "identity" as MemoryCategory, layer: "semantic" as MemoryLayer },
      { pattern: /i am (\w+)/, category: "identity" as MemoryCategory, layer: "semantic" as MemoryLayer },
      { pattern: /i work (?:as|at) ([\w\s]+)/, category: "identity" as MemoryCategory, layer: "semantic" as MemoryLayer },
    ];

    // Preference facts
    const preferencePatterns = [
      { pattern: /i (?:like|love|prefer|enjoy) ([\w\s]+)/, category: "preference" as MemoryCategory, layer: "semantic" as MemoryLayer },
      { pattern: /i (?:dislike|hate|don't like) ([\w\s]+)/, category: "preference" as MemoryCategory, layer: "semantic" as MemoryLayer },
    ];

    // Goal facts
    const goalPatterns = [
      { pattern: /i want to ([\w\s]+)/, category: "goal" as MemoryCategory, layer: "episodic" as MemoryLayer },
      { pattern: /my goal is ([\w\s]+)/, category: "goal" as MemoryCategory, layer: "episodic" as MemoryLayer },
      { pattern: /i'm (?:working on|building|creating) ([\w\s]+)/, category: "project" as MemoryCategory, layer: "episodic" as MemoryLayer },
    ];

    // Behavioral facts
    const behaviorPatterns = [
      { pattern: /i usually ([\w\s]+)/, category: "behavior" as MemoryCategory, layer: "procedural" as MemoryLayer },
      { pattern: /i always ([\w\s]+)/, category: "behavior" as MemoryCategory, layer: "procedural" as MemoryLayer },
    ];

    const allPatterns = [...identityPatterns, ...preferencePatterns, ...goalPatterns, ...behaviorPatterns];

    for (const { pattern, category, layer } of allPatterns) {
      const matches = content.match(pattern);
      if (matches && matches[1]) {
        const factText = matches[1].trim();
        if (factText.length > 2 && factText.length < 200) {
          facts.push({
            text: factText,
            category,
            layer,
            importance: this.calculateImportance(factText, category),
            confidence: this.calculateConfidence(turn.content, pattern),
            evidence: [turn.content],
            contradicts: this.findContradictions(factText, category, existingMemories),
          });
        }
      }
    }

    // Extract explicit memory commands
    if (turn.content.toLowerCase().includes("remember this") || turn.content.toLowerCase().includes("remember that")) {
      const memoryContent = turn.content.replace(/remember (?:this|that)[:\s]*/i, "").trim();
      if (memoryContent.length > 5) {
        facts.push({
          text: memoryContent,
          category: "preference",
          layer: "episodic",
          importance: 0.9,
          confidence: 0.95,
          evidence: [turn.content],
          contradicts: this.findContradictions(memoryContent, "preference", existingMemories),
        });
      }
    }

    return facts;
  }

  private calculateImportance(text: string, category: MemoryCategory): number {
    let importance = 0.5;
    
    if (category === "identity") importance = 0.9;
    else if (category === "goal") importance = 0.8;
    else if (category === "project") importance = 0.8;
    else if (category === "preference") importance = 0.7;
    else if (category === "relationship") importance = 0.8;
    else if (category === "behavior") importance = 0.6;
    
    // Boost for explicit memory commands
    if (text.length > 100) importance = Math.min(1, importance + 0.1);
    
    return importance;
  }

  private calculateConfidence(fullText: string, pattern: RegExp): number {
    // Higher confidence for explicit statements
    if (fullText.toLowerCase().includes("remember this")) return 0.95;
    if (fullText.toLowerCase().includes("my name is")) return 0.9;
    if (fullText.toLowerCase().includes("my goal is")) return 0.85;
    return 0.6;
  }

  private findContradictions(text: string, category: MemoryCategory, existingMemories: Memory[]): string[] {
    const contradictions: string[] = [];
    const lowerText = text.toLowerCase();
    
    for (const mem of existingMemories) {
      if (mem.category !== category) continue;
      if (mem.metadata.userId && mem.metadata.userId !== "current") continue;
      
      const memText = mem.text.toLowerCase();
      
      // Simple contradiction detection
      if (category === "preference") {
        const likeWords = ["like", "love", "enjoy", "prefer"];
        const dislikeWords = ["dislike", "hate", "don't like"];
        
        const hasLike = likeWords.some(w => lowerText.includes(w));
        const hasDislike = dislikeWords.some(w => lowerText.includes(w));
        const memHasLike = likeWords.some(w => memText.includes(w));
        const memHasDislike = dislikeWords.some(w => memText.includes(w));
        
        if ((hasLike && memHasDislike) || (hasDislike && memHasLike)) {
          contradictions.push(mem.id);
        }
      }
      
      if (category === "identity" && this.textsContradict(text, mem.text)) {
        contradictions.push(mem.id);
      }
    }
    
    return contradictions;
  }

  private textsContradict(a: string, b: string): boolean {
    // Simple contradiction: "I am X" vs "I am Y" where X != Y
    const aWords = a.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    const bWords = b.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    
    if (aWords.length === 0 || bWords.length === 0) return false;
    
    // If they share no significant words, might be contradictory
    const intersection = aWords.filter(w => bWords.includes(w));
    return intersection.length === 0 && aWords.length > 0 && bWords.length > 0;
  }

  private generateTransactions(
    candidate: ConsolidationCandidate,
    existingMemories: Memory[],
    userId: string
  ): MemoryTransaction[] {
    const transactions: MemoryTransaction[] = [];

    for (const fact of candidate.extractedFacts) {
      // Check for duplicates
      const duplicate = this.findDuplicate(fact, existingMemories);
      if (duplicate) {
        // Update existing memory with reinforced confidence
        transactions.push({
          action: "UPDATE",
          id: duplicate.id,
          layer: fact.layer,
          category: fact.category,
          text: this.mergeTexts(duplicate.text, fact.text),
          metadata: {
            importance: Math.max(duplicate.metadata.importance, fact.importance),
            confidence: Math.min(1, duplicate.metadata.confidence + 0.1),
            lastReinforced: Date.now(),
            relationships: [...new Set([...duplicate.metadata.relationships, ...fact.evidence.map(e => e.substring(0, 50))])],
          },
        });
        continue;
      }

      // Check for contradictions
      if (fact.contradicts.length > 0) {
        for (const contradictedId of fact.contradicts) {
          const contradictedMem = existingMemories.find(m => m.id === contradictedId);
          if (contradictedMem && fact.confidence > this.config.contradictionConfidenceThreshold) {
            transactions.push({
              action: "UPDATE",
              id: contradictedMem.id,
              layer: fact.layer,
              category: fact.category,
              text: fact.text,
              metadata: {
                importance: fact.importance,
                confidence: fact.confidence,
                timestamp: Date.now(),
                lastReinforced: Date.now(),
                relationships: [...fact.evidence.map(e => e.substring(0, 50)), `supersedes:${contradictedId}`],
              },
            });
          }
        }
      }

      // Add new memory
      transactions.push({
        action: "ADD",
        id: "",
        layer: fact.layer,
        category: fact.category,
        text: fact.text,
        metadata: {
          importance: fact.importance,
          confidence: fact.confidence,
          source: "conversation",
          timestamp: Date.now(),
          lastAccessed: Date.now(),
          lastReinforced: Date.now(),
          category: fact.category,
          relationships: fact.evidence.map(e => e.substring(0, 50)),
          userId,
        },
      });
    }

    return transactions;
  }

  private findDuplicate(fact: ExtractedFact, existingMemories: Memory[]): Memory | null {
    for (const mem of existingMemories) {
      if (mem.category !== fact.category) continue;
      if (mem.layer !== fact.layer) continue;
      
      const similarity = this.calculateSimilarity(fact.text, mem.text);
      if (similarity >= this.config.duplicationSimilarityThreshold) {
        return mem;
      }
    }
    return null;
  }

  private calculateSimilarity(a: string, b: string): number {
    const aWords = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length > 2));
    const bWords = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length > 2));
    
    if (aWords.size === 0 || bWords.size === 0) return 0;
    
    const intersection = new Set([...aWords].filter(x => bWords.has(x)));
    const union = new Set([...aWords, ...bWords]);
    
    return intersection.size / union.size;
  }

  private mergeTexts(existing: string, newText: string): string {
    // Simple merge - keep the more detailed one
    return newText.length > existing.length ? newText : existing;
  }

  getHistory(): ConsolidationCandidate[] {
    return [...this.consolidationHistory];
  }
}

export function createMemoryConsolidation(config?: Partial<ConsolidationConfig>): MemoryConsolidation {
  return new MemoryConsolidation(config);
}
