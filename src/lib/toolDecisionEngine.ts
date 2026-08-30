import { CognitiveState, CandidateAction } from "./cognitiveState";

export interface ToolDefinition {
  name: string;
  description: string;
  category: "conversation" | "memory" | "web" | "browser" | "windows" | "filesystem" | "system";
  riskLevel: "LOW" | "MEDIUM" | "HIGH";
  requiredPermissions: string[];
  estimatedLatencyMs: number;
  canChain: boolean;
}

export const AVAILABLE_TOOLS: ToolDefinition[] = [
  {
    name: "conversation",
    description: "Direct conversational response without external tools",
    category: "conversation",
    riskLevel: "LOW",
    requiredPermissions: [],
    estimatedLatencyMs: 100,
    canChain: false,
  },
  {
    name: "memory_retrieval",
    description: "Search and retrieve relevant memories",
    category: "memory",
    riskLevel: "LOW",
    requiredPermissions: ["memory.read"],
    estimatedLatencyMs: 200,
    canChain: true,
  },
  {
    name: "memory_store",
    description: "Store new information in memory",
    category: "memory",
    riskLevel: "LOW",
    requiredPermissions: ["memory.write"],
    estimatedLatencyMs: 150,
    canChain: true,
  },
  {
    name: "web_search",
    description: "Search the web for information",
    category: "web",
    riskLevel: "MEDIUM",
    requiredPermissions: ["web.search"],
    estimatedLatencyMs: 3000,
    canChain: true,
  },
  {
    name: "browser_open",
    description: "Open a website in the browser agent",
    category: "browser",
    riskLevel: "MEDIUM",
    requiredPermissions: ["browser.control"],
    estimatedLatencyMs: 2000,
    canChain: true,
  },
  {
    name: "browser_search",
    description: "Search within the active browser page",
    category: "browser",
    riskLevel: "MEDIUM",
    requiredPermissions: ["browser.control"],
    estimatedLatencyMs: 1500,
    canChain: true,
  },
  {
    name: "browser_click",
    description: "Click an element in the browser",
    category: "browser",
    riskLevel: "MEDIUM",
    requiredPermissions: ["browser.control"],
    estimatedLatencyMs: 1000,
    canChain: true,
  },
  {
    name: "browser_media_control",
    description: "Control media playback (play, pause, volume, etc.)",
    category: "browser",
    riskLevel: "LOW",
    requiredPermissions: ["browser.control"],
    estimatedLatencyMs: 500,
    canChain: true,
  },
  {
    name: "windows_open_app",
    description: "Open a Windows application",
    category: "windows",
    riskLevel: "HIGH",
    requiredPermissions: ["windows.apps"],
    estimatedLatencyMs: 3000,
    canChain: true,
  },
  {
    name: "windows_file_ops",
    description: "File operations (create, read, write, delete)",
    category: "windows",
    riskLevel: "HIGH",
    requiredPermissions: ["windows.files"],
    estimatedLatencyMs: 1000,
    canChain: true,
  },
  {
    name: "filesystem_read",
    description: "Read a file from the filesystem",
    category: "filesystem",
    riskLevel: "MEDIUM",
    requiredPermissions: ["filesystem.read"],
    estimatedLatencyMs: 500,
    canChain: true,
  },
  {
    name: "filesystem_write",
    description: "Write a file to the filesystem",
    category: "filesystem",
    riskLevel: "HIGH",
    requiredPermissions: ["filesystem.write"],
    estimatedLatencyMs: 500,
    canChain: true,
  },
];

export interface ToolDecisionConfig {
  maxToolsPerDecision: number;
  preferLowRisk: boolean;
  maxChainLength: number;
  latencyBudgetMs: number;
}

export const DEFAULT_TOOL_CONFIG: ToolDecisionConfig = {
  maxToolsPerDecision: 3,
  preferLowRisk: true,
  maxChainLength: 3,
  latencyBudgetMs: 5000,
};

export interface ToolDecision {
  primaryTool: string;
  chainedTools: string[];
  reasoning: string;
  confidence: number;
  estimatedTotalLatencyMs: number;
  riskLevel: "LOW" | "MEDIUM" | "HIGH";
}

export class ToolDecisionEngine {
  private config: ToolDecisionConfig;
  private decisionHistory: ToolDecision[] = [];

  constructor(config: Partial<ToolDecisionConfig> = {}) {
    this.config = { ...DEFAULT_TOOL_CONFIG, ...config };
  }

  decide(state: CognitiveState, availableTools: string[] = []): ToolDecision {
    const tools = AVAILABLE_TOOLS.filter(t => 
      availableTools.length === 0 || availableTools.includes(t.name)
    );

    const context = this.analyzeContext(state);
    const candidates = this.scoreTools(tools, context);
    const selected = this.selectTools(candidates);

    const decision: ToolDecision = {
      primaryTool: selected.primary,
      chainedTools: selected.chained,
      reasoning: this.generateReasoning(selected, context),
      confidence: selected.confidence,
      estimatedTotalLatencyMs: this.estimateLatency(selected),
      riskLevel: this.assessRisk(selected),
    };

    this.decisionHistory.push(decision);
    if (this.decisionHistory.length > 100) {
      this.decisionHistory.shift();
    }

    return decision;
  }

  private analyzeContext(state: CognitiveState) {
    return {
      hasUserQuery: state.userIntent !== null,
      hasActiveTask: state.activeGoal !== null,
      hasPendingTasks: state.pendingTasks.length > 0,
      conversationActive: state.conversationState === "active",
      needsMemory: state.relevantMemories.length > 0,
      needsExternalInfo: this.needsExternalInfo(state),
      needsAction: state.urgency > 0.5,
      availableLatency: this.config.latencyBudgetMs,
    };
  }

  private needsExternalInfo(state: CognitiveState): boolean {
    if (!state.userIntent) return false;
    const intent = state.userIntent.toLowerCase();
    const externalTriggers = [
      "search", "find", "look up", "what is", "who is", "how to",
      "latest", "current", "news", "weather", "price", "compare"
    ];
    return externalTriggers.some(t => intent.includes(t));
  }

  private scoreTools(tools: ToolDefinition[], context: ReturnType<typeof this.analyzeContext>): Array<{tool: ToolDefinition; score: number; reason: string}> {
    return tools.map(tool => {
      let score = 0;
      const reasons: string[] = [];

      // Base scoring by category
      if (context.needsExternalInfo && tool.category === "web") {
        score += 0.9;
        reasons.push("External info needed");
      }
      if (context.hasUserQuery && tool.category === "conversation") {
        score += 0.7;
        reasons.push("Conversational response");
      }
      if (context.needsMemory && (tool.category === "memory")) {
        score += 0.8;
        reasons.push("Memory operation needed");
      }
      if (context.hasActiveTask && (tool.category === "browser" || tool.category === "windows")) {
        score += 0.6;
        reasons.push("Active task may need tools");
      }
      if (context.needsAction && tool.category === "windows") {
        score += 0.7;
        reasons.push("Action required");
      }

      // Risk penalty
      if (this.config.preferLowRisk) {
        if (tool.riskLevel === "HIGH") score -= 0.3;
        else if (tool.riskLevel === "MEDIUM") score -= 0.1;
      }

      // Latency consideration
      if (tool.estimatedLatencyMs > context.availableLatency * 0.5) {
        score -= 0.2;
      }

      return { tool, score: Math.max(0, score), reason: reasons.join(", ") };
    }).sort((a, b) => b.score - a.score);
  }

  private selectTools(candidates: Array<{tool: ToolDefinition; score: number; reason: string}>): {primary: string; chained: string[]; confidence: number} {
    const primary = candidates[0];
    const chained: string[] = [];

    let remainingLatency = this.config.latencyBudgetMs - primary.tool.estimatedLatencyMs;
    let chainLength = 0;

    for (const candidate of candidates.slice(1)) {
      if (chainLength >= this.config.maxChainLength) break;
      if (!candidate.tool.canChain) continue;
      if (candidate.tool.estimatedLatencyMs > remainingLatency) continue;
      if (candidate.score < 0.5) break;

      chained.push(candidate.tool.name);
      remainingLatency -= candidate.tool.estimatedLatencyMs;
      chainLength++;
    }

    return {
      primary: primary.tool.name,
      chained,
      confidence: Math.min(1, primary.score + (chained.length * 0.05)),
    };
  }

  private generateReasoning(selected: {primary: string; chained: string[]; confidence: number}, context: ReturnType<typeof this.analyzeContext>): string {
    const primaryTool = AVAILABLE_TOOLS.find(t => t.name === selected.primary);
    let reason = `Selected ${selected.primary} (${primaryTool?.category})`;

    if (context.needsExternalInfo) reason += " for external information";
    if (context.needsMemory) reason += " with memory access";
    if (context.hasActiveTask) reason += " for active task";
    
    if (selected.chained.length > 0) {
      reason += `; chained: ${selected.chained.join(", ")}`;
    }

    reason += `. Confidence: ${Math.round(selected.confidence * 100)}%`;
    return reason;
  }

  private estimateLatency(selected: {primary: string; chained: string[]}): number {
    const primaryTool = AVAILABLE_TOOLS.find(t => t.name === selected.primary);
    let total = primaryTool?.estimatedLatencyMs || 0;
    
    for (const chainedName of selected.chained) {
      const tool = AVAILABLE_TOOLS.find(t => t.name === chainedName);
      if (tool) total += tool.estimatedLatencyMs;
    }
    
    return total;
  }

  private assessRisk(selected: {primary: string; chained: string[]}): "LOW" | "MEDIUM" | "HIGH" {
    const tools = [selected.primary, ...selected.chained];
    const riskLevels = tools.map(name => {
      const tool = AVAILABLE_TOOLS.find(t => t.name === name);
      return tool?.riskLevel || "LOW";
    });
    
    if (riskLevels.includes("HIGH")) return "HIGH";
    if (riskLevels.includes("MEDIUM")) return "MEDIUM";
    return "LOW";
  }

  getHistory(): ToolDecision[] {
    return [...this.decisionHistory];
  }

  getStats() {
    const byTool = this.decisionHistory.reduce((acc, d) => {
      acc[d.primaryTool] = (acc[d.primaryTool] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    return {
      totalDecisions: this.decisionHistory.length,
      byTool,
      avgConfidence: this.decisionHistory.reduce((s, d) => s + d.confidence, 0) / this.decisionHistory.length || 0,
    };
  }

  reset(): void {
    this.decisionHistory = [];
  }
}

export function createToolDecisionEngine(config?: Partial<ToolDecisionConfig>): ToolDecisionEngine {
  return new ToolDecisionEngine(config);
}