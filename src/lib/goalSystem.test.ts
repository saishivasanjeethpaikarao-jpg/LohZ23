import { describe, it, expect, beforeEach } from "vitest";
import { GoalSystem, DEFAULT_GOAL_CONFIG, createGoalSystem } from "./goalSystem";

describe("GoalSystem", () => {
  let gs: GoalSystem;
  beforeEach(() => { gs = createGoalSystem(); });

  describe("goals", () => {
    it("should create a goal", () => {
      const goal = gs.createGoal("u1", "Learn Rust");
      expect(goal.description).toBe("Learn Rust");
      expect(goal.userId).toBe("u1");
      expect(goal.status).toBe("active");
      expect(goal.id).toMatch(/^goal_/);
    });

    it("should get a goal by id", () => {
      const goal = gs.createGoal("u1", "test");
      expect(gs.getGoal(goal.id)).toBeDefined();
    });

    it("should get user goals", () => {
      gs.createGoal("u1", "g1");
      gs.createGoal("u2", "g2");
      expect(gs.getUserGoals("u1").length).toBe(1);
    });

    it("should get active goals", () => {
      const g = gs.createGoal("u1", "active");
      gs.updateGoal(g.id, { status: "completed" });
      expect(gs.getActiveGoals("u1").length).toBe(0);
    });

    it("should update a goal", () => {
      const g = gs.createGoal("u1", "test");
      const updated = gs.updateGoal(g.id, { description: "updated" });
      expect(updated!.description).toBe("updated");
    });

    it("should return null for updating nonexistent goal", () => {
      expect(gs.updateGoal("nope", { description: "x" })).toBeNull();
    });

    it("should update goal progress", () => {
      const g = gs.createGoal("u1", "test");
      gs.updateGoalProgress(g.id, 0.5);
      expect(gs.getGoal(g.id)!.progress).toBe(0.5);
    });

    it("should clamp progress to [0,1]", () => {
      const g = gs.createGoal("u1", "test");
      gs.updateGoalProgress(g.id, 1.5);
      expect(gs.getGoal(g.id)!.progress).toBe(1);
      gs.updateGoalProgress(g.id, -0.5);
      expect(gs.getGoal(g.id)!.progress).toBe(0);
    });

    it("should auto-complete goal at progress 1", () => {
      const g = gs.createGoal("u1", "test");
      gs.updateGoalProgress(g.id, 1);
      expect(gs.getGoal(g.id)!.status).toBe("completed");
    });

    it("should delete a goal", () => {
      const g = gs.createGoal("u1", "test");
      expect(gs.deleteGoal(g.id)).toBe(true);
      expect(gs.getGoal(g.id)).toBeUndefined();
    });

    it("should return false for deleting nonexistent goal", () => {
      expect(gs.deleteGoal("nope")).toBe(false);
    });

    it("should enforce max active goals", () => {
      const small = createGoalSystem({ maxActiveGoals: 2 });
      small.createGoal("u1", "g1");
      small.createGoal("u1", "g2");
      expect(() => small.createGoal("u1", "g3")).toThrow();
    });
  });

  describe("tasks", () => {
    it("should create a task", () => {
      const t = gs.createTask("u1", "do stuff");
      expect(t.description).toBe("do stuff");
      expect(t.status).toBe("pending");
      expect(t.id).toMatch(/^task_/);
    });

    it("should link task to goal", () => {
      const g = gs.createGoal("u1", "goal");
      gs.createTask("u1", "task1", { goalId: g.id });
      expect(gs.getGoalTasks(g.id).length).toBe(1);
    });

    it("should get user tasks", () => {
      gs.createTask("u1", "t1");
      gs.createTask("u2", "t2");
      expect(gs.getUserTasks("u1").length).toBe(1);
    });

    it("should update a task", () => {
      const t = gs.createTask("u1", "test");
      const updated = gs.updateTask(t.id, { status: "in_progress" });
      expect(updated!.status).toBe("in_progress");
    });

    it("should complete a task", () => {
      const g = gs.createGoal("u1", "goal");
      const t = gs.createTask("u1", "task", { goalId: g.id });
      gs.completeTask(t.id);
      expect(gs.getTask(t.id)!.status).toBe("completed");
    });

    it("should delete a task", () => {
      const t = gs.createTask("u1", "test");
      expect(gs.deleteTask(t.id)).toBe(true);
      expect(gs.getTask(t.id)).toBeUndefined();
    });
  });

  describe("getPendingTasks", () => {
    it("should return pending and in_progress tasks", () => {
      gs.createTask("u1", "pending1");
      const t2 = gs.createTask("u1", "inprog1");
      gs.updateTask(t2.id, { status: "in_progress" });
      const pending = gs.getPendingTasks("u1");
      expect(pending.length).toBe(2);
    });

    it("should sort by priority descending", () => {
      gs.createTask("u1", "low", { priority: 0.3 });
      gs.createTask("u1", "high", { priority: 0.9 });
      const pending = gs.getPendingTasks("u1");
      expect(pending[0].priority).toBeGreaterThanOrEqual(pending[1].priority);
    });
  });

  describe("stats", () => {
    it("should report stats for a user", () => {
      gs.createGoal("u1", "g1");
      gs.createTask("u1", "t1");
      const stats = gs.getStats("u1");
      expect(stats.totalGoals).toBe(1);
      expect(stats.totalTasks).toBe(1);
    });
  });

  describe("reset", () => {
    it("should clear all state", () => {
      gs.createGoal("u1", "g1");
      gs.createTask("u1", "t1");
      gs.reset();
      expect(gs.getUserGoals("u1").length).toBe(0);
      expect(gs.getUserTasks("u1").length).toBe(0);
    });
  });
});

describe("DEFAULT_GOAL_CONFIG", () => {
  it("should have sensible defaults", () => {
    expect(DEFAULT_GOAL_CONFIG.maxActiveGoals).toBe(10);
    expect(DEFAULT_GOAL_CONFIG.defaultPriority).toBe(0.5);
  });
});
