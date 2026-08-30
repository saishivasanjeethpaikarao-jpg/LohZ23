import { AVAILABLE_TOOLS, ToolDefinition } from "./toolDecisionEngine";

// ── Types ──

export type StepStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed"
  | "blocked"
  | "skipped"
  | "awaiting_confirmation";

export type PlanStatus =
  | "draft"
  | "executing"
  | "completed"
  | "failed"
  | "paused"
  | "aborted";

export type FailureStrategy = "retry" | "alternative" | "replan" | "ask_user" | "abort";

export interface PlanStep {
  id: string;
  description: string;
  toolRequired: string | null;
  riskLevel: "LOW" | "MEDIUM" | "HIGH";
  dependencies: string[];
  status: StepStatus;
  result?: StepResult;
  retryCount: number;
  maxRetries: number;
  alternativeTools: string[];
  parameters: Record<string, unknown>;
  expectedOutcome: string;
  verificationCriteria: string[];
  requiresConfirmation: boolean;
}

export interface StepResult {
  success: boolean;
  output: unknown;
  error?: string;
  latencyMs: number;
  timestamp: number;
  verificationPassed?: boolean;
  verificationDetails?: string;
}

export interface Plan {
  id: string;
  userId: string;
  goal: string;
  steps: PlanStep[];
  status: PlanStatus;
  confidence: number;
  riskLevel: "LOW" | "MEDIUM" | "HIGH";
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  executionHistory: StepResult[];
  failureStrategy: FailureStrategy;
  maxSteps: number;
  modelUsed: boolean;
}

export interface PlanConfig {
  maxSteps: number;
  defaultMaxRetries: number;
  confidenceThreshold: number;
  requireConfirmationForHighRisk: boolean;
  availableTools: string[];
  grantedPermissions: string[];
  criticalTools: string[];
}

export const DEFAULT_PLAN_CONFIG: PlanConfig = {
  maxSteps: 20,
  defaultMaxRetries: 2,
  confidenceThreshold: 0.3,
  requireConfirmationForHighRisk: true,
  availableTools: AVAILABLE_TOOLS.map(t => t.name),
  grantedPermissions: [],
  criticalTools: [],
};

// ── Step Decomposition Rules ──

interface DecompositionRule {
  pattern: RegExp;
  decompose: (goal: string) => string[];
}

const DECOMPOSITION_RULES: DecompositionRule[] = [
  {
    pattern: /^(search|find|look up|google)\s+(.+)/i,
    decompose: (goal) => [
      `Search for: ${goal}`,
      "Read search results",
      "Summarize findings",
    ],
  },
  {
    pattern: /^(create|write|make|generate)\s+(.+)/i,
    decompose: (goal) => [
      `Understand requirements for: ${goal}`,
      "Draft content",
      "Review and refine",
    ],
  },
  {
    pattern: /^(open|launch|start)\s+(.+)/i,
    decompose: (goal) => [
      `Open ${goal}`,
      "Verify application started",
    ],
  },
  {
    pattern: /^(read|show|display|view)\s+(.+)/i,
    decompose: (goal) => [
      `Locate ${goal}`,
      "Read content",
      "Display results",
    ],
  },
  {
    pattern: /^(save|store|remember)\s+(.+)/i,
    decompose: (goal) => [
      `Process information: ${goal}`,
      "Store in memory",
      "Confirm storage",
    ],
  },
  {
    pattern: /^(send|email|message)\s+(.+)/i,
    decompose: (goal) => [
      `Prepare message: ${goal}`,
      "Validate recipient",
      "Send message",
    ],
  },
  {
    pattern: /^(calculate|compute|figure out)\s+(.+)/i,
    decompose: (goal) => [
      `Parse request: ${goal}`,
      "Perform calculation",
      "Present result",
    ],
  },
];

// ── TaskPlanner ──

export class TaskPlanner {
  private config: PlanConfig;
  private plans: Map<string, Plan> = new Map();
  private userPlans: Map<string, Set<string>> = new Map();
  private planHistory: Plan[] = [];

  constructor(config: Partial<PlanConfig> = {}) {
    this.config = { ...DEFAULT_PLAN_CONFIG, ...config };
  }

  // ── Plan Creation ──

  createPlan(userId: string, goal: string, useModel: boolean = false): Plan {
    const steps = this.decomposeGoal(goal);
    const now = Date.now();

    const planSteps: PlanStep[] = steps.map((desc, i) => {
      const tool = this.matchTool(desc);
      const risk = tool?.riskLevel ?? "LOW";
      const needsConfirm = risk === "HIGH" && this.config.requireConfirmationForHighRisk;

      return {
        id: `step_${now}_${i}`,
        description: desc,
        toolRequired: tool?.name ?? null,
        riskLevel: risk,
        dependencies: i > 0 ? [`step_${now}_${i - 1}`] : [],
        status: "pending",
        retryCount: 0,
        maxRetries: this.config.defaultMaxRetries,
        alternativeTools: this.findAlternatives(tool?.name ?? null, tool?.category),
        parameters: {},
        expectedOutcome: this.inferExpectedOutcome(desc),
        verificationCriteria: this.inferVerificationCriteria(desc),
        requiresConfirmation: needsConfirm,
      };
    });

    const plan: Plan = {
      id: `plan_${now}_${Math.random().toString(36).substr(2, 9)}`,
      userId,
      goal,
      steps: planSteps,
      status: "draft",
      confidence: 1.0,
      riskLevel: this.calculatePlanRisk(planSteps),
      createdAt: now,
      updatedAt: now,
      executionHistory: [],
      failureStrategy: "retry",
      maxSteps: this.config.maxSteps,
      modelUsed: useModel,
    };

    this.plans.set(plan.id, plan);
    const userPlanIds = this.userPlans.get(userId) || new Set();
    userPlanIds.add(plan.id);
    this.userPlans.set(userId, userPlanIds);

    return plan;
  }

  // ── Plan Retrieval ──

  getPlan(planId: string): Plan | undefined {
    return this.plans.get(planId);
  }

  getUserPlans(userId: string): Plan[] {
    const planIds = this.userPlans.get(userId) || new Set();
    return Array.from(planIds)
      .map(id => this.plans.get(id))
      .filter((p): p is Plan => p !== undefined);
  }

  getActivePlan(userId: string): Plan | undefined {
    return this.getUserPlans(userId).find(
      p => p.status === "executing" || p.status === "draft"
    );
  }

  // ── Step Execution ──

  executeStep(
    planId: string,
    stepId: string,
    execute: (step: PlanStep) => StepResult
  ): { plan: Plan; step: PlanStep; shouldContinue: boolean } {
    const plan = this.plans.get(planId);
    if (!plan) throw new Error(`Plan not found: ${planId}`);

    const step = plan.steps.find(s => s.id === stepId);
    if (!step) throw new Error(`Step not found: ${stepId}`);

    // Check dependencies
    if (!this.dependenciesMet(plan, step)) {
      return { plan, step, shouldContinue: false };
    }

    // Check stop conditions
    const stopReason = this.checkStopConditions(plan);
    if (stopReason) {
      plan.status = "aborted";
      plan.updatedAt = Date.now();
      return { plan, step, shouldContinue: false };
    }

    // Check critical tool availability before execution
    if (step.toolRequired && this.config.criticalTools.includes(step.toolRequired)) {
      if (!this.config.availableTools.includes(step.toolRequired)) {
        step.status = "blocked";
        step.result = {
          success: false,
          output: null,
          error: `Critical tool unavailable: ${step.toolRequired}`,
          latencyMs: 0,
          timestamp: Date.now(),
        };
        plan.updatedAt = Date.now();
        return { plan, step, shouldContinue: false };
      }
    }

    // Check tool safety
    if (step.requiresConfirmation && step.status !== "awaiting_confirmation") {
      step.status = "awaiting_confirmation";
      plan.updatedAt = Date.now();
      return { plan, step, shouldContinue: false };
    }

    // Execute
    step.status = "in_progress";
    plan.status = "executing";
    plan.updatedAt = Date.now();

    const result = execute(step);
    step.result = result;
    plan.executionHistory.push(result);

    if (result.success) {
      const verified = this.verifyStep(step, result);
      result.verificationPassed = verified.passed;
      result.verificationDetails = verified.details;

      if (verified.passed) {
        step.status = "completed";
      } else {
        result.error = `Verification failed: ${verified.details}`;
        this.handleFailure(plan, step);
      }
    } else {
      this.handleFailure(plan, step);
    }

    // Check if plan is complete
    const complete = this.isPlanComplete(plan);
    if (complete) {
      plan.status = "completed";
      plan.completedAt = Date.now();
      plan.updatedAt = Date.now();
    }

    return { plan, step, shouldContinue: !complete && plan.status === "executing" };
  }

  // ── Failure Handling ──

  handleFailure(plan: Plan, step: PlanStep): void {
    const canRetry = step.retryCount < step.maxRetries;
    const strategy = this.selectFailureStrategy(plan, step, canRetry);
    plan.failureStrategy = strategy;

    switch (strategy) {
      case "retry":
        step.retryCount++;
        step.status = "pending";
        break;
      case "alternative":
        step.retryCount++;
        if (step.alternativeTools.length > 0) {
          const alt = step.alternativeTools.shift()!;
          step.toolRequired = alt;
          step.parameters = { ...step.parameters, _alternativeUsed: alt };
        }
        step.status = "pending";
        break;
      case "replan":
        step.retryCount++;
        this.replan(plan, step);
        break;
      case "ask_user":
        step.status = "awaiting_confirmation";
        break;
      case "abort":
        plan.status = "aborted";
        plan.updatedAt = Date.now();
        break;
    }
  }

  // ── User Feedback ──

  userConfirmStep(planId: string, stepId: string): Plan | null {
    const plan = this.plans.get(planId);
    if (!plan) return null;

    const step = plan.steps.find(s => s.id === stepId);
    if (!step || step.status !== "awaiting_confirmation") return null;

    step.status = "pending";
    plan.updatedAt = Date.now();
    return plan;
  }

  userProvideGuidance(planId: string, stepId: string, guidance: string): Plan | null {
    const plan = this.plans.get(planId);
    if (!plan) return null;

    const step = plan.steps.find(s => s.id === stepId);
    if (!step) return null;

    step.parameters = { ...step.parameters, _userGuidance: guidance };
    step.status = "pending";
    step.retryCount = 0;
    plan.updatedAt = Date.now();
    return plan;
  }

  userAbortPlan(planId: string): Plan | null {
    const plan = this.plans.get(planId);
    if (!plan) return null;

    plan.status = "aborted";
    plan.updatedAt = Date.now();
    return plan;
  }

  // ── Plan Status ──

  getPlanStatus(planId: string): {
    status: PlanStatus;
    completedSteps: number;
    totalSteps: number;
    failedSteps: number;
    blockedSteps: number;
    nextStep: PlanStep | null;
    confidence: number;
    riskLevel: "LOW" | "MEDIUM" | "HIGH";
  } | null {
    const plan = this.plans.get(planId);
    if (!plan) return null;

    const completed = plan.steps.filter(s => s.status === "completed").length;
    const failed = plan.steps.filter(s => s.status === "failed").length;
    const blocked = plan.steps.filter(s => s.status === "blocked").length;
    const next = this.getNextStep(plan);

    return {
      status: plan.status,
      completedSteps: completed,
      totalSteps: plan.steps.length,
      failedSteps: failed,
      blockedSteps: blocked,
      nextStep: next,
      confidence: plan.confidence,
      riskLevel: plan.riskLevel,
    };
  }

  // ── Memory Candidates ──

  getProceduralMemoryCandidates(planId: string): {
    goal: string;
    steps: string[];
    successRate: number;
    toolsUsed: string[];
  } | null {
    const plan = this.plans.get(planId);
    if (!plan || plan.status !== "completed") return null;

    const completedSteps = plan.steps.filter(s => s.status === "completed");
    const toolsUsed = [...new Set(
      completedSteps.map(s => s.toolRequired).filter((t): t is string => t !== null)
    )];

    return {
      goal: plan.goal,
      steps: completedSteps.map(s => s.description),
      successRate: completedSteps.length / plan.steps.length,
      toolsUsed,
    };
  }

  getReflectionCandidates(planId: string): {
    goal: string;
    failedSteps: { description: string; error: string; strategy: FailureStrategy }[];
    lessonsLearned: string[];
  } | null {
    const plan = this.plans.get(planId);
    if (!plan || (plan.status !== "failed" && plan.status !== "aborted")) return null;

    const failedSteps = plan.steps
      .filter(s => s.status === "failed" || s.status === "awaiting_confirmation")
      .map(s => ({
        description: s.description,
        error: s.result?.error ?? "Unknown error",
        strategy: plan.failureStrategy,
      }));

    const lessonsLearned = failedSteps.map(f =>
      `Step "${f.description}" failed with: ${f.error}. Strategy used: ${f.strategy}`
    );

    return {
      goal: plan.goal,
      failedSteps,
      lessonsLearned,
    };
  }

  getFailedPlanPatterns(): { goal: string; failCount: number; lastFailure: number }[] {
    const patterns: Record<string, { failCount: number; lastFailure: number }> = {};

    for (const plan of this.planHistory) {
      if (plan.status === "failed" || plan.status === "aborted") {
        const key = plan.goal.toLowerCase();
        if (!patterns[key]) {
          patterns[key] = { failCount: 0, lastFailure: 0 };
        }
        patterns[key].failCount++;
        patterns[key].lastFailure = Math.max(patterns[key].lastFailure, plan.updatedAt);
      }
    }

    return Object.entries(patterns)
      .map(([goal, data]) => ({ goal, ...data }))
      .sort((a, b) => b.failCount - a.failCount);
  }

  // ── Reset ──

  archivePlan(planId: string): boolean {
    const plan = this.plans.get(planId);
    if (!plan) return false;

    if (plan.status === "completed" || plan.status === "failed" || plan.status === "aborted") {
      this.planHistory.push(plan);
      this.plans.delete(planId);
      this.userPlans.get(plan.userId)?.delete(planId);
      return true;
    }
    return false;
  }

  reset(): void {
    this.plans.clear();
    this.userPlans.clear();
    this.planHistory = [];
  }

  // ── Internal Helpers ──

  private decomposeGoal(goal: string): string[] {
    for (const rule of DECOMPOSITION_RULES) {
      if (rule.pattern.test(goal)) {
        return rule.decompose(goal);
      }
    }

    // Default: single-step plan
    return [goal];
  }

  private matchTool(description: string): ToolDefinition | null {
    const lower = description.toLowerCase();

    for (const tool of AVAILABLE_TOOLS) {
      const keywords = tool.name.split("_");
      if (keywords.some(kw => lower.includes(kw))) {
        return tool;
      }
    }

    // Fuzzy matching on tool descriptions
    for (const tool of AVAILABLE_TOOLS) {
      const toolWords = tool.description.toLowerCase().split(/\W+/);
      const descWords = lower.split(/\W+/);
      const overlap = toolWords.filter(w => descWords.includes(w) && w.length > 3);
      if (overlap.length >= 2) {
        return tool;
      }
    }

    return null;
  }

  private findAlternatives(toolName: string | null, category?: string): string[] {
    if (!toolName) return [];
    return AVAILABLE_TOOLS
      .filter(t => t.name !== toolName && t.category === category)
      .map(t => t.name);
  }

  private inferExpectedOutcome(description: string): string {
    const lower = description.toLowerCase();
    if (lower.startsWith("search")) return "Search results retrieved";
    if (lower.startsWith("read")) return "Content read successfully";
    if (lower.startsWith("create") || lower.startsWith("write")) return "Content created";
    if (lower.startsWith("open")) return "Application opened";
    if (lower.startsWith("send")) return "Message sent";
    if (lower.startsWith("save") || lower.startsWith("store")) return "Data stored";
    return "Step completed";
  }

  private inferVerificationCriteria(description: string): string[] {
    const lower = description.toLowerCase();
    const criteria: string[] = ["Step completed without error"];

    if (lower.startsWith("search")) {
      criteria.push("Results returned", "Results relevant to query");
    } else if (lower.startsWith("read")) {
      criteria.push("Content accessible", "Content non-empty");
    } else if (lower.startsWith("open")) {
      criteria.push("Application running", "Window visible");
    } else if (lower.startsWith("send")) {
      criteria.push("Message delivered", "No send errors");
    }

    return criteria;
  }

  private verifyStep(step: PlanStep, result: StepResult): { passed: boolean; details: string } {
    if (!result.success) {
      return { passed: false, details: result.error ?? "Step failed" };
    }

    if (result.output === null || result.output === undefined) {
      return { passed: false, details: "No output produced" };
    }

    if (typeof result.output === "string" && result.output.trim().length === 0) {
      return { passed: false, details: "Empty output" };
    }

    if (result.error) {
      return { passed: false, details: result.error };
    }

    return { passed: true, details: "Verification passed" };
  }

  private dependenciesMet(plan: Plan, step: PlanStep): boolean {
    for (const depId of step.dependencies) {
      const dep = plan.steps.find(s => s.id === depId);
      if (!dep || dep.status !== "completed") {
        return false;
      }
    }
    return true;
  }

  private getNextStep(plan: Plan): PlanStep | null {
    for (const step of plan.steps) {
      if (step.status === "pending" && this.dependenciesMet(plan, step)) {
        return step;
      }
      if (step.status === "in_progress") {
        return step;
      }
    }
    return null;
  }

  private isPlanComplete(plan: Plan): boolean {
    return plan.steps.every(s => s.status === "completed" || s.status === "skipped");
  }

  private checkStopConditions(plan: Plan): string | null {
    if (plan.steps.filter(s => s.status === "completed").length >= plan.maxSteps) {
      return "Maximum steps reached";
    }

    if (plan.confidence < this.config.confidenceThreshold) {
      return "Confidence too low";
    }

    for (const step of plan.steps) {
      if (step.status === "in_progress" && step.toolRequired) {
        if (this.config.criticalTools.includes(step.toolRequired)) {
          if (!this.config.availableTools.includes(step.toolRequired)) {
            return `Critical tool unavailable: ${step.toolRequired}`;
          }
        }
      }
    }

    return null;
  }

  private selectFailureStrategy(plan: Plan, step: PlanStep, canRetry: boolean): FailureStrategy {
    if (!canRetry) {
      if (step.alternativeTools.length > 0) return "alternative";
      return "ask_user";
    }

    if (step.alternativeTools.length > 0) return "alternative";
    return "retry";
  }

  private replan(plan: Plan, failedStep: PlanStep): void {
    const failedIndex = plan.steps.findIndex(s => s.id === failedStep.id);
    if (failedIndex === -1) return;

    // Remove failed step and any dependent steps
    const removedIds = new Set<string>();
    removedIds.add(failedStep.id);

    let changed = true;
    while (changed) {
      changed = false;
      for (const step of plan.steps) {
        if (!removedIds.has(step.id) && step.dependencies.some(d => removedIds.has(d))) {
          removedIds.add(step.id);
          changed = true;
        }
      }
    }

    plan.steps = plan.steps.filter(s => !removedIds.has(s.id));

    // Add a replacement step
    const now = Date.now();
    const replacement: PlanStep = {
      id: `step_${now}_replan`,
      description: `Recovery for: ${failedStep.description}`,
      toolRequired: null,
      riskLevel: "LOW",
      dependencies: [],
      status: "pending",
      retryCount: 0,
      maxRetries: 1,
      alternativeTools: [],
      parameters: { _recoveryFor: failedStep.id },
      expectedOutcome: "Recovery completed",
      verificationCriteria: ["Recovery step completed"],
      requiresConfirmation: false,
    };

    plan.steps.push(replacement);
    plan.updatedAt = Date.now();
  }

  private calculatePlanRisk(steps: PlanStep[]): "LOW" | "MEDIUM" | "HIGH" {
    if (steps.some(s => s.riskLevel === "HIGH")) return "HIGH";
    if (steps.some(s => s.riskLevel === "MEDIUM")) return "MEDIUM";
    return "LOW";
  }

  updateConfidence(planId: string, confidence: number): void {
    const plan = this.plans.get(planId);
    if (plan) {
      plan.confidence = Math.max(0, Math.min(1, confidence));
      plan.updatedAt = Date.now();
    }
  }
}
