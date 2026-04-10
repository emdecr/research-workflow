/**
 * task-manager.ts — Tracks all work in the workforce
 *
 * The TaskManager is the single source of truth for task state. It handles:
 * - Creating new tasks (root tasks and sub-tasks)
 * - Transitioning tasks between statuses
 * - Querying task relationships (parent/children)
 * - Enforcing rules (retry limits, valid transitions)
 *
 * WHY A CENTRAL MANAGER?
 *
 * In a multi-agent system, multiple agents read and write task state
 * concurrently. If each agent tracked its own tasks, you'd have no way
 * to answer basic questions like "are all sub-tasks done?" without
 * asking every agent.
 *
 * The TaskManager solves this by being the ONE place where task state lives.
 * Agents don't store task state themselves — they call the TaskManager
 * to create, update, and query tasks.
 *
 * Think of it like a project management board (Jira, Trello). Agents are
 * the team members who move cards around. The board itself is the
 * TaskManager — it shows the current state of everything and enforces
 * workflow rules.
 *
 * IMPORTANT DESIGN DECISION: The TaskManager does NOT send messages.
 * It only manages state. The agents are responsible for sending messages
 * via the MessageBus after updating task state. This keeps the two
 * concerns separate:
 *   - TaskManager = "what is the state of work?"
 *   - MessageBus  = "how do agents communicate?"
 */

import { v4 as uuidv4 } from "uuid";
import type {
  AgentInfo,
  Task,
  TaskStatus,
  WorkforceConfig,
  WorkforceSession,
} from "./types.js";
import { DEFAULT_CONFIG } from "./types.js";
import { logSystem, logTaskUpdate, logError } from "./utils/logger.js";

export class TaskManager {
  /**
   * The session this manager is tracking. Contains the task map,
   * agent registry, and session-level state.
   */
  private session: WorkforceSession;

  /**
   * Configuration for task behavior (retry limits, timeouts, etc.)
   */
  private config: WorkforceConfig;

  constructor(originalQuestion: string, config?: Partial<WorkforceConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    // Initialize a fresh session
    this.session = {
      id: uuidv4(),
      originalQuestion,
      tasks: new Map(),
      agents: new Map(),
      status: "running",
      finalReport: null,
      startedAt: new Date(),
      completedAt: null,
    };

    logSystem(`Session created: "${originalQuestion}"`);
    logSystem(`Session ID: ${this.session.id}`);
  }

  // ===========================================================================
  // AGENT REGISTRATION
  // ===========================================================================

  /**
   * Register an agent with the session.
   * This doesn't "create" the agent — it just records that it exists
   * so we can reference it in tasks and validate message routing.
   */
  registerAgent(agent: AgentInfo): void {
    this.session.agents.set(agent.id, agent);
    logSystem(`Agent registered: ${agent.id} (${agent.role})`);
  }

  /**
   * Get a registered agent by ID.
   * Returns undefined if the agent isn't registered.
   */
  getAgent(agentId: string): AgentInfo | undefined {
    return this.session.agents.get(agentId);
  }

  // ===========================================================================
  // TASK CREATION
  // ===========================================================================

  /**
   * Create a new task and add it to the session.
   *
   * Tasks are created by agents (via the Coordinator or Synthesizer)
   * and tracked here. The caller specifies who the task is for and what
   * it contains — the TaskManager assigns an ID and initializes status.
   *
   * Returns the created task so the caller can reference its ID
   * when sending a "task:assign" message.
   */
  createTask(params: {
    parentTaskId: string | null;
    assignedTo: AgentInfo;
    createdBy: AgentInfo;
    description: string;
    input: string;
  }): Task {
    const task: Task = {
      id: uuidv4(),
      parentTaskId: params.parentTaskId,
      assignedTo: params.assignedTo,
      createdBy: params.createdBy,
      status: "pending",
      description: params.description,
      input: params.input,
      result: null,
      rejectionReason: null,
      retryCount: 0,
      maxRetries: this.config.defaultMaxRetries,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    this.session.tasks.set(task.id, task);
    logTaskUpdate(task.id, null, "pending", task.description);

    return task;
  }

  // ===========================================================================
  // TASK STATUS TRANSITIONS
  // ===========================================================================

  /**
   * Valid status transitions. This map enforces the task lifecycle rules
   * so agents can't accidentally put a task into an invalid state.
   *
   * The lifecycle is:
   *
   *   pending ──→ in-progress ──→ completed
   *                           ──→ rejected ──→ in-progress (retry)
   *                           ──→ failed
   *
   * Notice:
   * - You can't go from "completed" to anything (completed is final)
   * - You can't go from "failed" to anything (failed is final)
   * - "rejected" can only go back to "in-progress" (the retry)
   * - "pending" can only become "in-progress" (agent picks it up)
   */
  private static VALID_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
    pending: ["in-progress"],
    "in-progress": ["completed", "rejected", "failed"],
    completed: [], // Terminal state — no transitions out
    rejected: ["in-progress"], // Can only retry
    failed: [], // Terminal state — no transitions out
  };

  /**
   * Transition a task to a new status.
   *
   * This method enforces the lifecycle rules and updates the task.
   * It returns the updated task, or null if the transition was invalid.
   *
   * WHY RETURN NULL INSTEAD OF THROWING?
   * Because in a concurrent system, race conditions can cause
   * "invalid" transitions that are actually fine (e.g., two agents
   * trying to complete the same task). Returning null lets the caller
   * decide how to handle it without crashing the whole system.
   */
  updateTaskStatus(
    taskId: string,
    newStatus: TaskStatus,
    result?: string,
    rejectionReason?: string
  ): Task | null {
    const task = this.session.tasks.get(taskId);

    if (!task) {
      logError(`Task not found: ${taskId}`);
      return null;
    }

    // Validate the transition
    const validNextStates = TaskManager.VALID_TRANSITIONS[task.status];
    if (!validNextStates.includes(newStatus)) {
      logError(
        `Invalid task transition: ${task.status} → ${newStatus} for task ${taskId}`
      );
      return null;
    }

    // Record the old status for logging
    const oldStatus = task.status;

    // Apply the transition
    task.status = newStatus;
    task.updatedAt = new Date();

    // Handle status-specific fields
    if (newStatus === "completed" && result !== undefined) {
      task.result = result;
    }

    if (newStatus === "rejected") {
      task.rejectionReason = rejectionReason ?? null;
    }

    logTaskUpdate(taskId, oldStatus, newStatus, task.description);

    return task;
  }

  /**
   * Mark a task as in-progress for a retry attempt.
   *
   * This is a specific transition: rejected → in-progress.
   * It increments the retry counter and checks the limit.
   *
   * Returns null if retries are exhausted (the caller should
   * then mark the task as failed).
   *
   * WHY A SEPARATE METHOD?
   * Because retrying involves extra logic (increment counter,
   * check limit) that doesn't apply to a normal pending → in-progress
   * transition. Keeping it separate makes each method's intent clear.
   */
  retryTask(taskId: string): Task | null {
    const task = this.session.tasks.get(taskId);

    if (!task) {
      logError(`Task not found for retry: ${taskId}`);
      return null;
    }

    if (task.status !== "rejected") {
      logError(`Can only retry rejected tasks. Task ${taskId} is ${task.status}`);
      return null;
    }

    // Check retry limit
    if (task.retryCount >= task.maxRetries) {
      logError(
        `Task ${taskId} has exhausted retries (${task.retryCount}/${task.maxRetries})`
      );
      // Mark as failed — no more attempts
      return this.updateTaskStatus(taskId, "failed");
    }

    // Increment retry count and move back to in-progress
    task.retryCount++;
    logSystem(
      `Task ${taskId.slice(0, 8)} retry ${task.retryCount}/${task.maxRetries}`
    );

    return this.updateTaskStatus(taskId, "in-progress");
  }

  // ===========================================================================
  // TASK QUERIES
  // ===========================================================================

  /**
   * Get a task by ID.
   */
  getTask(taskId: string): Task | undefined {
    return this.session.tasks.get(taskId);
  }

  /**
   * Get all sub-tasks of a parent task.
   *
   * This is how the Coordinator checks "are all my research tasks done?"
   * It gets all sub-tasks and checks their statuses.
   */
  getSubTasks(parentTaskId: string): Task[] {
    const subTasks: Task[] = [];
    for (const task of this.session.tasks.values()) {
      if (task.parentTaskId === parentTaskId) {
        subTasks.push(task);
      }
    }
    return subTasks;
  }

  /**
   * Check if all sub-tasks of a parent are in a terminal state
   * (completed or failed). "Rejected" is NOT terminal — it means
   * a retry is expected.
   *
   * This is the Coordinator's main polling question:
   * "Can I move on to synthesis, or are researchers still working?"
   */
  areAllSubTasksDone(parentTaskId: string): boolean {
    const subTasks = this.getSubTasks(parentTaskId);

    // If there are no sub-tasks, there's nothing to wait for
    if (subTasks.length === 0) return true;

    return subTasks.every(
      (task) => task.status === "completed" || task.status === "failed"
    );
  }

  /**
   * Get all completed sub-tasks of a parent.
   * Used when collecting research findings for the Synthesizer.
   * Failed tasks are excluded — the Coordinator will note the gaps.
   */
  getCompletedSubTasks(parentTaskId: string): Task[] {
    return this.getSubTasks(parentTaskId).filter(
      (task) => task.status === "completed"
    );
  }

  /**
   * Get all tasks in the session, optionally filtered by status.
   */
  getAllTasks(status?: TaskStatus): Task[] {
    const tasks = Array.from(this.session.tasks.values());
    if (status) return tasks.filter((task) => task.status === status);
    return tasks;
  }

  // ===========================================================================
  // SESSION STATE
  // ===========================================================================

  /**
   * Get the current session.
   * Returns a reference (not a copy) — callers can read but should
   * use TaskManager methods to modify state.
   */
  getSession(): WorkforceSession {
    return this.session;
  }

  /**
   * Mark the session as completed with a final report.
   */
  completeSession(finalReport: string): void {
    this.session.status = "completed";
    this.session.finalReport = finalReport;
    this.session.completedAt = new Date();

    const durationMs =
      this.session.completedAt.getTime() - this.session.startedAt.getTime();
    const durationSec = (durationMs / 1000).toFixed(1);

    logSystem(`Session completed in ${durationSec}s`);
  }

  /**
   * Mark the session as failed.
   */
  failSession(reason: string): void {
    this.session.status = "failed";
    this.session.completedAt = new Date();
    logError(`Session failed: ${reason}`);
  }

  // ===========================================================================
  // SUMMARY / DEBUGGING
  // ===========================================================================

  /**
   * Print a summary of all tasks and their statuses.
   * Useful for debugging and for the final session report.
   *
   * Output looks like:
   *
   *   === Task Summary ===
   *   [root]     completed  "Research: What are the implications of..."
   *     [child]  completed  "Angle: Economic impact"
   *     [child]  completed  "Angle: Technical feasibility"
   *     [child]  failed     "Angle: Regulatory landscape"
   *     [child]  completed  "Synthesize findings into report"
   */
  printTaskSummary(): void {
    console.log("\n=== Task Summary ===");

    // First, print root tasks (parentTaskId === null)
    const rootTasks = this.getAllTasks().filter((t) => t.parentTaskId === null);

    for (const root of rootTasks) {
      const statusPad = root.status.padEnd(12);
      console.log(`  [root]     ${statusPad} "${root.description}"`);

      // Then print children of each root
      const children = this.getSubTasks(root.id);
      for (const child of children) {
        const childStatusPad = child.status.padEnd(12);
        const retryInfo =
          child.retryCount > 0 ? ` (${child.retryCount} retries)` : "";
        console.log(
          `    [child]  ${childStatusPad} "${child.description}"${retryInfo}`
        );
      }
    }

    // Count totals
    const all = this.getAllTasks();
    const completed = all.filter((t) => t.status === "completed").length;
    const failed = all.filter((t) => t.status === "failed").length;
    const totalRetries = all.reduce((sum, t) => sum + t.retryCount, 0);

    console.log(
      `\n  Total: ${all.length} tasks, ${completed} completed, ${failed} failed, ${totalRetries} retries`
    );
    console.log("====================\n");
  }
}
