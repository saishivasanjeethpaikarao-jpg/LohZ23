import {
  Memory,
  MemoryQuery,
  MemoryLayer,
  MemoryCategory,
  MemoryMetadata,
} from "./memoryTypes";

export interface RetrievalResult {
  memory: Memory;
  score: number;
  matchReason: string;
}

const LRU_CACHE_MAX = 64;
const LRU_CACHE_TTL_MS = 5000;

interface CacheEntry {
  results: RetrievalResult[];
  expiresAt: number;
}

export class MemoryRetrieval {
  private store: Map<string, Memory> = new Map();
  private queryCache: Map<string, CacheEntry> = new Map();

  constructor() {
    // seed empty
  }

  private invalidateCache(): void {
    this.queryCache.clear();
  }

  addMemory(memory: Memory): void {
    this.store.set(memory.id, memory);
    this.invalidateCache();
  }

  removeMemory(id: string): boolean {
    const deleted = this.store.delete(id);
    if (deleted) this.invalidateCache();
    return deleted;
  }

  getMemory(id: string): Memory | undefined {
    return this.store.get(id);
  }

  query(q: MemoryQuery): RetrievalResult[] {
    const cacheKey = `${q.userId}|${q.query ?? ""}|${q.layer ?? ""}|${q.category ?? ""}|${q.limit ?? 10}|${q.minImportance ?? 0}|${q.minConfidence ?? 0}`;
    const now = Date.now();

    const cached = this.queryCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.results;
    }

    const results: RetrievalResult[] = [];

    for (const mem of this.store.values()) {
      if (mem.metadata.userId !== q.userId) continue;
      if (q.layer && mem.layer !== q.layer) continue;
      if (q.category && mem.category !== q.category) continue;
      if (q.minImportance && mem.metadata.importance < q.minImportance) continue;
      if (q.minConfidence && mem.metadata.confidence < q.minConfidence) continue;

      const score = this.computeScore(mem, q.query, now);
      if (score > 0) {
        results.push({
          memory: mem,
          score,
          matchReason: this.explainMatch(mem, q.query),
        });
      }
    }

    results.sort((a, b) => b.score - a.score);
    const limit = q.limit ?? 10;
    const sliced = results.slice(0, limit);

    // Evict oldest cache entry if at capacity
    if (this.queryCache.size >= LRU_CACHE_MAX) {
      const oldestKey = this.queryCache.keys().next().value;
      if (oldestKey !== undefined) {
        this.queryCache.delete(oldestKey);
      }
    }
    this.queryCache.set(cacheKey, { results: sliced, expiresAt: now + LRU_CACHE_TTL_MS });

    return sliced;
  }

  private computeScore(mem: Memory, query: string | undefined, now: number): number {
    let score = 0;

    // Base importance weight
    score += mem.metadata.importance * 0.3;

    // Recency boost (decay over 30 days)
    const ageMs = now - mem.metadata.timestamp;
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    const recencyBoost = Math.max(0, 1 - ageDays / 30);
    score += recencyBoost * 0.25;

    // Access frequency boost
    const accessBoost = Math.min(1, (mem.metadata.lastReinforced - mem.metadata.timestamp) / (1000 * 60 * 60 * 24 * 7));
    score += accessBoost * 0.1;

    // Text similarity (simple token overlap)
    if (query) {
      const queryLower = query.toLowerCase();
      const textLower = mem.text.toLowerCase();
      const queryTokens = queryLower.split(/\s+/).filter((t) => t.length > 2);
      const textTokens = new Set(textLower.split(/\s+/));

      let overlap = 0;
      for (const token of queryTokens) {
        if (textTokens.has(token)) overlap++;
      }
      if (queryTokens.length > 0) {
        score += (overlap / queryTokens.length) * 0.35;
      }
    }

    return score;
  }

  private explainMatch(mem: Memory, query: string | undefined): string {
    const reasons: string[] = [];

    if (mem.metadata.importance > 0.7) {
      reasons.push(`high importance (${mem.metadata.importance.toFixed(2)})`);
    }

    const ageMs = Date.now() - mem.metadata.timestamp;
    if (ageMs < 1000 * 60 * 60 * 24) {
      reasons.push("recent");
    }

    if (query) {
      const queryLower = query.toLowerCase();
      const textLower = mem.text.toLowerCase();
      if (textLower.includes(queryLower.slice(0, 8))) {
        reasons.push("text match");
      }
    }

    return reasons.join(", ") || "general relevance";
  }

  getRecent(limit: number = 20): Memory[] {
    return [...this.store.values()]
      .sort((a, b) => b.metadata.timestamp - a.metadata.timestamp)
      .slice(0, limit);
  }

  getByLayer(layer: MemoryLayer, limit: number = 20): Memory[] {
    return [...this.store.values()]
      .filter((m) => m.layer === layer)
      .sort((a, b) => b.metadata.importance - a.metadata.importance)
      .slice(0, limit);
  }

  getByCategory(category: MemoryCategory, limit: number = 20): Memory[] {
    return [...this.store.values()]
      .filter((m) => m.category === category)
      .sort((a, b) => b.metadata.importance - a.metadata.importance)
      .slice(0, limit);
  }

  getAll(): Memory[] {
    return [...this.store.values()];
  }

  count(): number {
    return this.store.size;
  }

  load(memories: Memory[]): void {
    this.store.clear();
    this.queryCache.clear();
    for (const m of memories) {
      this.store.set(m.id, m);
    }
  }
}

export default MemoryRetrieval;