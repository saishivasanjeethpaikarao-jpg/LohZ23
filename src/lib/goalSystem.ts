import { PendingTask } from "./cognitiveState";

export interface Goal {
  id: string;
  userId: string;
  description: string;
  status: "active" | "paused" | "completed" | "cancelled";
  priority: number;
  createdAt: number;
  updatedAt: number;
  targetDate?: number;
  relatedTasks: string[];
  progress: number;
  context: string;
  tags: string[];
}

export interface Task {
  id: string;
  userId: string;
  goalId?: string;
  description: string;
  status: "pending" | "in_progress" | "completed" | "blocked" | "cancelled";
  priority: number;
  createdAt: number;
  updatedAt: number;
  dueDate?: number;
  estimatedDuration?: number;
  actualDuration?: number;
  dependencies: string[];
  context: string;
  tags: string[];
}

export interface GoalSystemConfig {
  maxActiveGoals: number;
  defaultPriority: number;
  autoArchiveCompletedDays: number;
}

export const DEFAULT_GOAL_CONFIG: GoalSystemConfig = {
  maxActiveGoals: 10,
  defaultPriority: 0.5,
  autoArchiveCompletedDays: 30,
};

export class GoalSystem {
  private config: GoalSystemConfig;
  private goals: Map<string, Goal> = new Map();
  private tasks: Map<string, Task> = new Map();
  private userGoals: Map<string, Set<string>> = new Map();

  constructor(config: Partial<GoalSystemConfig> = {}) {
    this.config = { ...DEFAULT_GOAL_CONFIG, ...config };
  }

  // Goal management
  createGoal(userId: string, description: string, options: Partial<Goal> = {}): Goal {
    const userGoalIds = this.userGoals.get(userId) || new Set();
    const activeGoals = Array.from(userGoalIds)
      .map(id => this.goals.get(id))
      .filter(g => g && (g.status === "active" || g.status === "paused"));

    if (activeGoals.length >= this.config.maxActiveGoals) {
      throw new Error(`Maximum active goals (${this.config.maxActiveGoals}) reached`);
    }

    const now = Date.now();
    const goal: Goal = {
      id: `goal_${now}_${Math.random().toString(36).substr(2, 9)}`,
      userId,
      description,
      status: "active",
      priority: options.priority ?? this.config.defaultPriority,
      createdAt: now,
      updatedAt: now,
      targetDate: options.targetDate,
      relatedTasks: [],
      progress: 0,
      context: options.context || "",
      tags: options.tags || [],
    };

    this.goals.set(goal.id, goal);
    userGoalIds.add(goal.id);
    this.userGoals.set(userId, userGoalIds);
    return goal;
  }

  getGoal(goalId: string): Goal | undefined {
    return this.goals.get(goalId);
  }

  getUserGoals(userId: string): Goal[] {
    const goalIds = this.userGoals.get(userId) || new Set();
    return Array.from(goalIds)
      .map(id => this.goals.get(id))
      .filter((g): g is Goal => g !== undefined);
  }

  getActiveGoals(userId: string): Goal[] {
    return this.getUserGoals(userId).filter(g => g.status === "active");
  }

  updateGoal(goalId: string, updates: Partial<Goal>): Goal | null {
    const goal = this.goals.get(goalId);
    if (!goal) return null;

    const updated = { ...goal, ...updates, updatedAt: Date.now() };
    this.goals.set(goalId, updated);
    return updated;
  }

  updateGoalProgress(goalId: string, progress: number): Goal | null {
    const goal = this.goals.get(goalId);
    if (!goal) return null;

    const clampedProgress = Math.max(0, Math.min(1, progress));
    const updated = { 
      ...goal, 
      progress: clampedProgress,
      status: clampedProgress >= 1 ? "completed" : goal.status,
      updatedAt: Date.now(),
    };
    this.goals.set(goalId, updated);
    return updated;
  }

  deleteGoal(goalId: string): boolean {
    const goal = this.goals.get(goalId);
    if (!goal) return false;

    // Also delete related tasks
    for (const taskId of goal.relatedTasks) {
      this.tasks.delete(taskId);
    }

    this.goals.delete(goalId);
    this.userGoals.get(goal.userId)?.delete(goalId);
    return true;
  }

  // Task management
  createTask(userId: string, description: string, options: Partial<Task> = {}): Task {
    const now = Date.now();
    const task: Task = {
      id: `task_${now}_${Math.random().toString(36).substr(2, 9)}`,
      userId,
      goalId: options.goalId,
      description,
      status: "pending",
      priority: options.priority ?? this.config.defaultPriority,
      createdAt: now,
      updatedAt: now,
      dueDate: options.dueDate,
      estimatedDuration: options.estimatedDuration,
      actualDuration: options.actualDuration,
      dependencies: options.dependencies || [],
      context: options.context || "",
      tags: options.tags || [],
    };

    this.tasks.set(task.id, task);

    // Link to goal if provided
    if (task.goalId) {
      const goal = this.goals.get(task.goalId);
      if (goal) {
        goal.relatedTasks.push(task.id);
        this.goals.set(goal.id, goal);
      }
    }

    return task;
  }

  getTask(taskId: string): Task | undefined {
    return this.tasks.get(taskId);
  }

  getUserTasks(userId: string): Task[] {
    return Array.from(this.tasks.values()).filter(t => t.userId === userId);
  }

  getGoalTasks(goalId: string): Task[] {
    const goal = this.goals.get(goalId);
    if (!goal) return [];
    return goal.relatedTasks.map(id => this.tasks.get(id)).filter((t): t is Task => t !== undefined);
  }

  updateTask(taskId: string, updates: Partial<Task>): Task | null {
    const task = this.tasks.get(taskId);
    if (!task) return null;

    const updated = { ...task, ...updates, updatedAt: Date.now() };
    this.tasks.set(taskId, updated);
    return updated;
  }

  completeTask(taskId: string): Task | null {
    const task = this.tasks.get(taskId);
    if (!task) return null;

    const now = Date.now();
    const updated = {
      ...task,
      status: "completed" as const,
      actualDuration: task.estimatedDuration ? task.actualDuration || 0 : undefined,
      updatedAt: now,
    };
    this.tasks.set(taskId, updated);

    // Update goal progress
    if (task.goalId) {
      const goal = this.goals.get(task.goalId);
      if (goal) {
        const goalTasks = this.getGoalTasks(task.goalId);
        const completedCount = goalTasks.filter(t => t.status === "completed").length;
        const progress = goalTasks.length > 0 ? completedCount / goalTasks.length : 0;
        this.updateGoalProgress(task.goalId, progress);
      }
    }

    return updated;
  }

  deleteTask(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;

    // Remove from goal
    if (task.goalId) {
      const goal = this.goals.get(task.goalId);
      if (goal) {
        goal.relatedTasks = goal.relatedTasks.filter(id => id !== taskId);
        this.goals.set(goal.id, goal);
      }
    }

    this.tasks.delete(taskId);
    return true;
  }

  // Get pending tasks for cognitive state
  getPendingTasks(userId: string): PendingTask[] {
    const userTasks = this.getUserTasks(userId);
    return userTasks
      .filter(t => t.status === "pending" || t.status === "in_progress")
      .map(t => ({
        id: t.id,
        description: t.description,
        status: t.status as "pending" | "in_progress",
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
        priority: t.priority,
        relatedGoal: t.goalId ? this.goals.get(t.goalId!)?.description : undefined,
      }))
      .sort((a, b) => b.priority - a.priority);
  }

  // Archive old completed goals
  archiveOldGoals(): number {
    const now = Date.now();
    const cutoff = now - (this.config.autoArchiveCompletedDays * 86400000);
    let archived = 0;

    for (const [id, goal] of this.goals.entries()) {
      if (goal.status === "completed" && goal.updatedAt < cutoff) {
        goal.status = "cancelled";
        this.goals.set(id, goal);
        archived++;
      }
    }

    return archived;
  }

  getStats(userId?: string) {
    const goals = userId ? this.getUserGoals(userId) : Array.from(this.goals.values());
    const tasks = userId ? this.getUserTasks(userId) : Array.from(this.tasks.values());

    return {
      totalGoals: goals.length,
      activeGoals: goals.filter(g => g.status === "active").length,
      completedGoals: goals.filter(g => g.status === "completed").length,
      totalTasks: tasks.length,
      pendingTasks: tasks.filter(t => t.status === "pending").length,
      inProgressTasks: tasks.filter(t => t.status === "in_progress").length,
      completedTasks: tasks.filter(t => t.status === "completed").length,
    };
  }

  reset(): void {
    this.goals.clear();
    this.tasks.clear();
    this.userGoals.clear();
  }
}

export function createGoalSystem(config?: Partial<GoalSystemConfig>): GoalSystem {
  return new GoalSystem(config);
}