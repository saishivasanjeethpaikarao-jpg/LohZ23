import { Memory, MemoryLayer, MemoryCategory, ConversationTurn, MemoryTransaction } from "./memoryTypes";

export interface ReflectionConfig {
  minConversationLength: number;
  reflectionIntervalMs: number;
  minImportanceForReflection: number;
  maxReflectionsPerDay: number;
}

export const DEFAULT_REFLECTION_CONFIG: ReflectionConfig = {
  minConversationLength: 4,
  reflectionIntervalMs: 3600000, // 1 hour
  minImportanceForReflection: 0.5,
  maxReflectionsPerDay: 10,
};

export interface ReflectionResult {
  timestamp: number;
  conversationId: string;
  insights: ReflectionInsight[];
  memoryUpdates: MemoryTransaction[];
  strategyUpdates: StrategyUpdate[];
}

export interface ReflectionInsight {
  type: "learning" | "correction" | "pattern" | "preference" | "goal_progress" | "contradiction";
  description: string;
  confidence: number;
  evidence: string[];
  relatedMemoryIds: string[];
}

export interface StrategyUpdate {
  strategyId: string;
  name: string;
  description: string;
  successRate: number;
  useCount: number;
  lastUpdated: number;
  context: string;
  improvement: string;
}

export class ReflectionEngine {
  private config: ReflectionConfig;
  private reflectionHistory: ReflectionResult[] = [];
  private lastReflectionTime: number = 0;
  private reflectionsToday: number = 0;
  private dayWindowStart: number = Date.now();

  constructor(config: Partial<ReflectionConfig> = {}) {
    this.config = { ...DEFAULT_REFLECTION_CONFIG, ...config };
  }

  private extractTopics(text: string): string[] {
    const stopWords = new Set(["the","is","in","at","which","on","a","an","and","or","but","for","with","to","of","this","that","it","from","by","as","are","was","were","be","been","being","have","has","had","do","does","did","will","would","could","should","may","might","shall","can","need","must","not","no","so","if","then","than","too","very","just","about","above","after","again","all","also","any","because","before","between","both","each","few","more","most","other","some","such","only","own","same","than","now"]);
    const words = text.toLowerCase().split(/\W+/).filter(w => w.length > 3 && !stopWords.has(w));
    const freq: Record<string, number> = {};
    for (const w of words) { freq[w] = (freq[w] || 0) + 1; }
    return Object.entries(freq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([word]) => word);
  }

  async reflect(
    conversation: ConversationTurn[],
    existingMemories: Memory[],
    userId: string,
    conversationId: string
  ): Promise<ReflectionResult | null> {
    const now = Date.now();
    
    // Check rate limits
    if (!this.canReflect(now)) {
      return null;
    }

    if (conversation.length < this.config.minConversationLength) {
      return null;
    }

    const insights: ReflectionInsight[] = [];
    const memoryUpdates: MemoryTransaction[] = [];
    const strategyUpdates: StrategyUpdate[] = [];

    // Analyze what was learned
    insights.push(...this.analyzeLearnings(conversation, existingMemories, userId));
    
    // Check for corrections
    insights.push(...this.detectCorrections(conversation, existingMemories, userId));
    
    // Identify patterns
    insights.push(...this.identifyPatterns(conversation, existingMemories));
    
    // Track goal progress
    insights.push(...this.analyzeGoalProgress(conversation, existingMemories));
    
    // Check for contradictions
    insights.push(...this.detectContradictions(conversation, existingMemories, userId));

    // Generate memory updates from insights
    for (const insight of insights) {
      if (insight.type === "learning" || insight.type === "preference") {
        memoryUpdates.push(...this.createMemoryUpdateFromInsight(insight, userId));
      }
      if (insight.type === "correction") {
        memoryUpdates.push(...this.createCorrectionUpdate(insight, existingMemories, userId));
      }
    }

    // Update strategies
    strategyUpdates.push(...this.updateStrategies(insights, conversation));

    const result: ReflectionResult = {
      timestamp: now,
      conversationId,
      insights,
      memoryUpdates,
      strategyUpdates,
    };

    this.reflectionHistory.push(result);
    this.lastReflectionTime = now;
    this.reflectionsToday++;

    if (this.reflectionHistory.length > 50) {
      this.reflectionHistory.shift();
    }

    return result;
  }

  private canReflect(now: number): boolean {
    // Check daily limit
    if (now - this.dayWindowStart > 86400000) {
      this.dayWindowStart = now;
      this.reflectionsToday = 0;
    }
    if (this.reflectionsToday >= this.config.maxReflectionsPerDay) {
      return false;
    }

    // Check interval
    if (now - this.lastReflectionTime < this.config.reflectionIntervalMs) {
      return false;
    }

    return true;
  }

  private analyzeLearnings(conversation: ConversationTurn[], existingMemories: Memory[], userId: string): ReflectionInsight[] {
    const insights: ReflectionInsight[] = [];
    
    // Extract topics discussed
    const userMessages = conversation.filter(t => t.role === "user").map(t => t.content);
    const topics = this.extractTopics(userMessages.join(" "));
    
    for (const topic of topics) {
      const existingKnowledge = existingMemories.filter(m => 
        m.layer === "semantic" && m.text.toLowerCase().includes(topic.toLowerCase())
      );
      
      if (existingKnowledge.length === 0) {
        insights.push({
          type: "learning",
          description: `New topic encountered: ${topic}`,
          confidence: 0.7,
          evidence: [`User discussed ${topic}`],
          relatedMemoryIds: [],
        });
      }
    }
    
    return insights;
  }

  private detectCorrections(conversation: ConversationTurn[], existingMemories: Memory[], userId: string): ReflectionInsight[] {
    const insights: ReflectionInsight[] = [];
    const userMessages = conversation.filter(t => t.role === "user").map(t => t.content.toLowerCase());
    
    for (const mem of existingMemories) {
      if (mem.metadata.userId !== userId) continue;
      
      for (const msg of userMessages) {
        // Check for explicit corrections
        const correctionPatterns = [
          "actually, ",
          "that's not right",
          "you're wrong",
          "incorrect",
          "no, ",
          "wrong, ",
          "not ",
        ];
        
        for (const pattern of correctionPatterns) {
          if (msg.includes(pattern)) {
            // Check if this message contradicts an existing memory
            const memText = mem.text.toLowerCase();
            const msgWords = msg.split(/\s+/).filter(w => w.length > 3);
            const memWords = memText.split(/\s+/).filter(w => w.length > 3);
            const overlap = msgWords.filter(w => memWords.includes(w)).length;
            
            if (overlap > 1) {
              insights.push({
                type: "correction",
                description: `User corrected memory: "${mem.text}"`,
                confidence: 0.8,
                evidence: [msg],
                relatedMemoryIds: [mem.id],
              });
            }
          }
        }
      }
    }
    
    return insights;
  }

  private identifyPatterns(conversation: ConversationTurn[], existingMemories: Memory[]): ReflectionInsight[] {
    const insights: ReflectionInsight[] = [];
    
    // Tool usage patterns
    const toolMessages = conversation.filter(t => 
      t.metadata && (t.metadata as any).toolUsed
    );
    
    if (toolMessages.length >= 3) {
      const tools = toolMessages.map(t => (t.metadata as any).toolUsed);
      const toolCounts = tools.reduce((acc, t) => {
        acc[t] = (acc[t] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);
      
      const toolEntries: [string, number][] = Object.entries(toolCounts);
      const topTool = toolEntries.sort((a, b) => b[1] - a[1])[0];
      if (topTool && topTool[1] >= 3) {
        insights.push({
          type: "pattern",
          description: `Frequent tool usage pattern: ${topTool[0]} (${topTool[1]} times)`,
          confidence: 0.75,
          evidence: [`Tool ${topTool[0]} used ${topTool[1]} times in conversation`],
          relatedMemoryIds: [],
        });
      }
    }
    
    return insights;
  }

  private analyzeGoalProgress(conversation: ConversationTurn[], existingMemories: Memory[]): ReflectionInsight[] {
    const insights: ReflectionInsight[] = [];
    
    const goalMemories = existingMemories.filter(m => m.category === "goal");
    const userMessages = conversation.filter(t => t.role === "user").map(t => t.content.toLowerCase());
    
    for (const goal of goalMemories) {
      const goalKeywords = goal.text.toLowerCase().split(/\s+/).filter(w => w.length > 3);
      const mentions = userMessages.filter(msg => 
        goalKeywords.some(kw => msg.includes(kw))
      ).length;
      
      if (mentions > 0) {
        const progressWords = ["done", "finished", "completed", "achieved", "got it", "working", "progress"];
        const hasProgress = userMessages.some(msg => 
          progressWords.some(pw => msg.includes(pw)) && 
          goalKeywords.some(kw => msg.includes(kw))
        );
        
        if (hasProgress) {
          insights.push({
            type: "goal_progress",
            description: `Progress detected on goal: ${goal.text}`,
            confidence: 0.8,
            evidence: [`Goal mentioned ${mentions} times with progress indicators`],
            relatedMemoryIds: [goal.id],
          });
        }
      }
    }
    
    return insights;
  }

  private detectContradictions(conversation: ConversationTurn[], existingMemories: Memory[], userId: string): ReflectionInsight[] {
    const insights: ReflectionInsight[] = [];
    const userMessages = conversation.filter(t => t.role === "user").map(t => t.content.toLowerCase());
    
    for (const mem of existingMemories) {
      if (mem.metadata.userId !== userId) continue;
      
      for (const msg of userMessages) {
        // Check for preference contradictions
        if (mem.category === "preference") {
          const likeWords = ["like", "love", "enjoy", "prefer", "favorite"];
          const dislikeWords = ["dislike", "hate", "don't like", "not a fan", "can't stand"];
          
          const msgHasLike = likeWords.some(w => msg.includes(w));
          const msgHasDislike = dislikeWords.some(w => msg.includes(w));
          const memHasLike = likeWords.some(w => mem.text.toLowerCase().includes(w));
          const memHasDislike = dislikeWords.some(w => mem.text.toLowerCase().includes(w));
          
          if ((msgHasLike && memHasDislike) || (msgHasDislike && memHasLike)) {
            insights.push({
              type: "contradiction",
              description: `Contradiction detected: memory says "${mem.text}" but user now says "${msg}"`,
              confidence: 0.85,
              evidence: [msg, mem.text],
              relatedMemoryIds: [mem.id],
            });
          }
        }
      }
    }
    
    return insights;
  }

  private createMemoryUpdateFromInsight(insight: ReflectionInsight, userId: string): MemoryTransaction[] {
    const updates: MemoryTransaction[] = [];
    
    if (insight.type === "learning") {
      updates.push({
        action: "ADD",
        id: "",
        layer: "semantic",
        category: "concept",
        text: insight.description,
        metadata: {
          importance: 0.6,
          confidence: insight.confidence,
          source: "reflection",
          timestamp: Date.now(),
          lastAccessed: Date.now(),
          lastReinforced: Date.now(),
          category: "concept",
          relationships: insight.evidence,
          userId,
        },
      });
    }
    
    if (insight.type === "preference") {
      updates.push({
        action: "ADD",
        id: "",
        layer: "semantic",
        category: "preference",
        text: insight.description,
        metadata: {
          importance: 0.7,
          confidence: insight.confidence,
          source: "reflection",
          timestamp: Date.now(),
          lastAccessed: Date.now(),
          lastReinforced: Date.now(),
          category: "preference",
          relationships: insight.evidence,
          userId,
        },
      });
    }
    
    return updates;
  }

  private createCorrectionUpdate(insight: ReflectionInsight, existingMemories: Memory[], userId: string): MemoryTransaction[] {
    const updates: MemoryTransaction[] = [];
    
    for (const memId of insight.relatedMemoryIds) {
      const mem = existingMemories.find(m => m.id === memId);
      if (mem) {
        updates.push({
          action: "UPDATE",
          id: mem.id,
          layer: mem.layer,
          category: mem.category,
          text: insight.evidence[0] || mem.text,
          metadata: {
            ...mem.metadata,
            confidence: insight.confidence,
            lastReinforced: Date.now(),
            relationships: [...mem.metadata.relationships, `corrected:${Date.now()}`],
          },
        });
      }
    }
    
    return updates;
  }

  private updateStrategies(insights: ReflectionInsight[], conversation: ConversationTurn[]): StrategyUpdate[] {
    const updates: StrategyUpdate[] = [];
    
    // Track successful interaction patterns
    const successfulPatterns = insights.filter(i => i.type === "pattern" && i.confidence > 0.7);
    
    for (const pattern of successfulPatterns) {
      updates.push({
        strategyId: `pattern_${Date.now()}`,
        name: pattern.description,
        description: pattern.description,
        successRate: pattern.confidence,
        useCount: 1,
        lastUpdated: Date.now(),
        context: "conversation",
        improvement: "Identified from reflection",
      });
    }
    
    return updates;
  }

  getHistory(): ReflectionResult[] {
    return [...this.reflectionHistory];
  }

  getStats() {
    return {
      totalReflections: this.reflectionHistory.length,
      reflectionsToday: this.reflectionsToday,
      lastReflection: this.lastReflectionTime,
    };
  }

  reset(): void {
    this.reflectionHistory = [];
    this.lastReflectionTime = 0;
    this.reflectionsToday = 0;
    this.dayWindowStart = Date.now();
  }
}

export function createReflectionEngine(config?: Partial<ReflectionConfig>): ReflectionEngine {
  return new ReflectionEngine(config);
}
