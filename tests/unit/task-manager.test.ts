/**
 * task-manager.test.ts — Tests for the TaskManager
 *
 * These tests verify the task lifecycle:
 * - Task creation and tree structure
 * - Status transitions (valid and invalid)
 * - Retry logic with limits
 * - Sub-task queries
 * - Session management
 */

import { describe, it, expect, beforeEach } from "vitest";
import { TaskManager } from "../../src/task-manager.js";
import type { AgentInfo } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const coordinator: AgentInfo = { id: "coordinator-1", role: "coordinator" };
const researcher: AgentInfo = { id: "researcher-1", role: "researcher" };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TaskManager", () => {
  let tm: TaskManager;

  beforeEach(() => {
    tm = new TaskManager("Test research question");
  });

  // ---- Task Creation ----

  describe("createTask", () => {
    it("creates a task with correct initial state", () => {
      const task = tm.createTask({
        parentTaskId: null,
        assignedTo: coordinator,
        createdBy: coordinator,
        description: "Root task",
        input: "Research question",
      });

      expect(task.id).toBeDefined();
      expect(task.parentTaskId).toBeNull();
      expect(task.status).toBe("pending");
      expect(task.result).toBeNull();
      expect(task.rejectionReason).toBeNull();
      expect(task.retryCount).toBe(0);
    });

    it("creates sub-tasks linked to a parent", () => {
      const parent = tm.createTask({
        parentTaskId: null,
        assignedTo: coordinator,
        createdBy: coordinator,
        description: "Root",
        input: "Question",
      });

      const child = tm.createTask({
        parentTaskId: parent.id,
        assignedTo: researcher,
        createdBy: coordinator,
        description: "Research angle 1",
        input: "Angle details",
      });

      expect(child.parentTaskId).toBe(parent.id);

      const subTasks = tm.getSubTasks(parent.id);
      expect(subTasks).toHaveLength(1);
      expect(subTasks[0].id).toBe(child.id);
    });
  });

  // ---- Status Transitions ----

  describe("updateTaskStatus", () => {
    it("transitions pending → in-progress", () => {
      const task = tm.createTask({
        parentTaskId: null,
        assignedTo: researcher,
        createdBy: coordinator,
        description: "Test",
        input: "Test",
      });

      const updated = tm.updateTaskStatus(task.id, "in-progress");
      expect(updated?.status).toBe("in-progress");
    });

    it("transitions in-progress → completed with result", () => {
      const task = tm.createTask({
        parentTaskId: null,
        assignedTo: researcher,
        createdBy: coordinator,
        description: "Test",
        input: "Test",
      });

      tm.updateTaskStatus(task.id, "in-progress");
      const updated = tm.updateTaskStatus(
        task.id,
        "completed",
        "Research findings here"
      );

      expect(updated?.status).toBe("completed");
      expect(updated?.result).toBe("Research findings here");
    });

    it("transitions in-progress → rejected with reason", () => {
      const task = tm.createTask({
        parentTaskId: null,
        assignedTo: researcher,
        createdBy: coordinator,
        description: "Test",
        input: "Test",
      });

      tm.updateTaskStatus(task.id, "in-progress");
      const updated = tm.updateTaskStatus(
        task.id,
        "rejected",
        undefined,
        "Needs more detail"
      );

      expect(updated?.status).toBe("rejected");
      expect(updated?.rejectionReason).toBe("Needs more detail");
    });

    it("rejects invalid transitions", () => {
      const task = tm.createTask({
        parentTaskId: null,
        assignedTo: researcher,
        createdBy: coordinator,
        description: "Test",
        input: "Test",
      });

      // pending → completed is invalid (must go through in-progress)
      const result = tm.updateTaskStatus(task.id, "completed");
      expect(result).toBeNull();
      expect(tm.getTask(task.id)?.status).toBe("pending");
    });

    it("prevents transitions out of completed (terminal state)", () => {
      const task = tm.createTask({
        parentTaskId: null,
        assignedTo: researcher,
        createdBy: coordinator,
        description: "Test",
        input: "Test",
      });

      tm.updateTaskStatus(task.id, "in-progress");
      tm.updateTaskStatus(task.id, "completed", "Done");

      // completed → in-progress is invalid
      const result = tm.updateTaskStatus(task.id, "in-progress");
      expect(result).toBeNull();
      expect(tm.getTask(task.id)?.status).toBe("completed");
    });

    it("prevents transitions out of failed (terminal state)", () => {
      const task = tm.createTask({
        parentTaskId: null,
        assignedTo: researcher,
        createdBy: coordinator,
        description: "Test",
        input: "Test",
      });

      tm.updateTaskStatus(task.id, "in-progress");
      tm.updateTaskStatus(task.id, "failed");

      const result = tm.updateTaskStatus(task.id, "in-progress");
      expect(result).toBeNull();
    });

    it("returns null for non-existent task", () => {
      const result = tm.updateTaskStatus("fake-id", "in-progress");
      expect(result).toBeNull();
    });
  });

  // ---- Retry Logic ----

  describe("retryTask", () => {
    it("retries a rejected task and increments the counter", () => {
      const task = tm.createTask({
        parentTaskId: null,
        assignedTo: researcher,
        createdBy: coordinator,
        description: "Test",
        input: "Test",
      });

      tm.updateTaskStatus(task.id, "in-progress");
      tm.updateTaskStatus(task.id, "rejected", undefined, "Try harder");

      const retried = tm.retryTask(task.id);

      expect(retried?.status).toBe("in-progress");
      expect(retried?.retryCount).toBe(1);
    });

    it("marks task as failed when retries are exhausted", () => {
      const task = tm.createTask({
        parentTaskId: null,
        assignedTo: researcher,
        createdBy: coordinator,
        description: "Test",
        input: "Test",
      });

      // Default maxRetries is 2. Use them up.
      // Attempt 1 → rejected → retry 1
      tm.updateTaskStatus(task.id, "in-progress");
      tm.updateTaskStatus(task.id, "rejected");
      tm.retryTask(task.id); // retryCount = 1

      // Attempt 2 → rejected → retry 2
      tm.updateTaskStatus(task.id, "rejected");
      tm.retryTask(task.id); // retryCount = 2

      // Attempt 3 → rejected → retries exhausted → failed
      tm.updateTaskStatus(task.id, "rejected");
      const result = tm.retryTask(task.id);

      expect(result?.status).toBe("failed");
    });

    it("rejects retry on non-rejected tasks", () => {
      const task = tm.createTask({
        parentTaskId: null,
        assignedTo: researcher,
        createdBy: coordinator,
        description: "Test",
        input: "Test",
      });

      tm.updateTaskStatus(task.id, "in-progress");

      // Can't retry a task that isn't rejected
      const result = tm.retryTask(task.id);
      expect(result).toBeNull();
    });
  });

  // ---- Sub-task Queries ----

  describe("sub-task queries", () => {
    it("areAllSubTasksDone returns true when all children are completed/failed", () => {
      const parent = tm.createTask({
        parentTaskId: null,
        assignedTo: coordinator,
        createdBy: coordinator,
        description: "Root",
        input: "Q",
      });

      const child1 = tm.createTask({
        parentTaskId: parent.id,
        assignedTo: researcher,
        createdBy: coordinator,
        description: "Angle 1",
        input: "A1",
      });

      const child2 = tm.createTask({
        parentTaskId: parent.id,
        assignedTo: researcher,
        createdBy: coordinator,
        description: "Angle 2",
        input: "A2",
      });

      // Not done yet — both pending
      expect(tm.areAllSubTasksDone(parent.id)).toBe(false);

      // Complete one, fail the other
      tm.updateTaskStatus(child1.id, "in-progress");
      tm.updateTaskStatus(child1.id, "completed", "Findings");

      tm.updateTaskStatus(child2.id, "in-progress");
      tm.updateTaskStatus(child2.id, "failed");

      expect(tm.areAllSubTasksDone(parent.id)).toBe(true);
    });

    it("areAllSubTasksDone returns false when a child is rejected", () => {
      const parent = tm.createTask({
        parentTaskId: null,
        assignedTo: coordinator,
        createdBy: coordinator,
        description: "Root",
        input: "Q",
      });

      const child = tm.createTask({
        parentTaskId: parent.id,
        assignedTo: researcher,
        createdBy: coordinator,
        description: "Angle 1",
        input: "A1",
      });

      tm.updateTaskStatus(child.id, "in-progress");
      tm.updateTaskStatus(child.id, "rejected");

      // Rejected is NOT terminal — a retry is expected
      expect(tm.areAllSubTasksDone(parent.id)).toBe(false);
    });

    it("getCompletedSubTasks only returns completed tasks", () => {
      const parent = tm.createTask({
        parentTaskId: null,
        assignedTo: coordinator,
        createdBy: coordinator,
        description: "Root",
        input: "Q",
      });

      const child1 = tm.createTask({
        parentTaskId: parent.id,
        assignedTo: researcher,
        createdBy: coordinator,
        description: "Angle 1",
        input: "A1",
      });

      const child2 = tm.createTask({
        parentTaskId: parent.id,
        assignedTo: researcher,
        createdBy: coordinator,
        description: "Angle 2",
        input: "A2",
      });

      tm.updateTaskStatus(child1.id, "in-progress");
      tm.updateTaskStatus(child1.id, "completed", "Good findings");

      tm.updateTaskStatus(child2.id, "in-progress");
      tm.updateTaskStatus(child2.id, "failed");

      const completed = tm.getCompletedSubTasks(parent.id);
      expect(completed).toHaveLength(1);
      expect(completed[0].result).toBe("Good findings");
    });

    it("returns true for a parent with no sub-tasks", () => {
      const parent = tm.createTask({
        parentTaskId: null,
        assignedTo: coordinator,
        createdBy: coordinator,
        description: "Root",
        input: "Q",
      });

      expect(tm.areAllSubTasksDone(parent.id)).toBe(true);
    });
  });

  // ---- Session Management ----

  describe("session management", () => {
    it("initializes with running status", () => {
      const session = tm.getSession();
      expect(session.status).toBe("running");
      expect(session.finalReport).toBeNull();
    });

    it("completes the session with a report", () => {
      tm.completeSession("Final report content");

      const session = tm.getSession();
      expect(session.status).toBe("completed");
      expect(session.finalReport).toBe("Final report content");
      expect(session.completedAt).toBeInstanceOf(Date);
    });

    it("fails the session with a reason", () => {
      tm.failSession("Timeout");

      const session = tm.getSession();
      expect(session.status).toBe("failed");
      expect(session.completedAt).toBeInstanceOf(Date);
    });
  });

  // ---- Agent Registration ----

  describe("agent registration", () => {
    it("registers and retrieves agents", () => {
      tm.registerAgent(coordinator);
      tm.registerAgent(researcher);

      expect(tm.getAgent(coordinator.id)).toEqual(coordinator);
      expect(tm.getAgent(researcher.id)).toEqual(researcher);
      expect(tm.getAgent("unknown")).toBeUndefined();
    });
  });
});
