/**
 * types.ts — The shared vocabulary of the agent workforce
 *
 * This file defines every data structure that agents, the message bus,
 * and the task manager use to communicate. Think of it as the "contract"
 * that holds the system together.
 *
 * READ THIS FILE FIRST when exploring the codebase. Everything else
 * implements against these types.
 */

// =============================================================================
// AGENT IDENTITY
// =============================================================================

/**
 * The three roles in our workforce. Each role has different responsibilities:
 * - coordinator: Breaks the research question into angles, delegates, evaluates
 * - researcher:  Investigates a single angle in depth
 * - synthesizer: Merges all findings into a coherent final report
 */
export type AgentRole = "coordinator" | "researcher" | "synthesizer";

/**
 * A lightweight identifier for an agent. This gets attached to every task
 * and message so we always know who created/sent/received something.
 *
 * Why a separate type instead of just a string ID? Because we often need
 * both the ID (for routing messages) and the role (for logging and decisions).
 */
export interface AgentInfo {
  id: string; // e.g., "coordinator-1", "researcher-3"
  role: AgentRole;
}

// =============================================================================
// TASKS — Units of work
// =============================================================================

/**
 * A task moves through these states during its lifecycle:
 *
 *   pending → in-progress → completed
 *                         → rejected → (retry) → in-progress → ...
 *                         → failed
 *
 * "rejected" is the interesting one — it means the agent that requested
 * the work looked at the result and said "not good enough, try again."
 * This is what creates the quality feedback loop.
 */
export type TaskStatus =
  | "pending" // Created but not yet picked up by an agent
  | "in-progress" // An agent is actively working on it
  | "completed" // Done successfully, result is populated
  | "rejected" // Sent back with feedback for another attempt
  | "failed"; // Unrecoverable — gave up after max retries or hit an error

/**
 * A Task is the fundamental unit of work in the system.
 *
 * Tasks form a TREE structure:
 *   Root task (the original research question)
 *   ├── Sub-task: Research angle 1
 *   ├── Sub-task: Research angle 2
 *   ├── Sub-task: Research angle 3
 *   └── Sub-task: Synthesize findings
 *
 * The parentTaskId field creates this tree. The root task has parentTaskId = null.
 *
 * Why a tree? Because the Coordinator doesn't know in advance how many angles
 * to research — Claude decides that. And each angle might spawn further
 * sub-tasks if the Synthesizer requests deeper investigation.
 */
export interface Task {
  id: string;
  parentTaskId: string | null; // null = root task
  assignedTo: AgentInfo; // Who is responsible for this work
  createdBy: AgentInfo; // Who requested this work
  status: TaskStatus;
  description: string; // Human-readable: "Research the economic impact of..."
  input: string; // The actual content the agent will work with
  result: string | null; // Populated when status = "completed"
  rejectionReason: string | null; // Populated when status = "rejected"
  retryCount: number; // How many times this task has been retried
  maxRetries: number; // Safety limit — prevents infinite retry loops
  createdAt: Date;
  updatedAt: Date;
}

// =============================================================================
// MESSAGES — How agents talk to each other
// =============================================================================

/**
 * Message types define the "protocol" agents use to communicate.
 * Each type represents a specific kind of interaction:
 *
 * Task lifecycle:
 *   task:assign    — "Here's work for you to do"
 *   task:complete  — "I finished, here's my result"
 *   task:reject    — "This isn't good enough, here's why, try again"
 *   task:failed    — "I can't do this, here's why"
 *
 * Collaboration:
 *   clarification:ask    — "I need more info before I can proceed"
 *   clarification:reply  — "Here's the info you asked for"
 *
 * Observability:
 *   status:update  — "Here's what I'm currently doing" (progress updates)
 *
 * This is intentionally a closed set. Adding a new message type is a
 * deliberate design decision because every agent needs to handle it.
 */
export type MessageType =
  | "task:assign"
  | "task:complete"
  | "task:reject"
  | "task:failed"
  | "clarification:ask"
  | "clarification:reply"
  | "status:update";

/**
 * A message sent between two agents via the message bus.
 *
 * Messages are ALWAYS point-to-point (one sender, one receiver).
 * There's no broadcast. If the Coordinator wants to tell all Researchers
 * something, it sends individual messages to each one.
 *
 * Why point-to-point? Because every message is tied to a specific task,
 * and tasks have a specific assignee. Broadcasting would create confusion
 * about who is responsible for acting on the message.
 */
export interface AgentMessage {
  id: string;
  type: MessageType;
  from: AgentInfo;
  to: AgentInfo;
  taskId: string; // Every message is in the context of a task
  payload: string; // The actual content — findings, feedback, questions, etc.
  timestamp: Date;
}

// =============================================================================
// WORKFORCE SESSION — Top-level state
// =============================================================================

/**
 * A WorkforceSession represents a single run of the entire system.
 * It's the container for everything that happens from question to report.
 *
 * Think of it like a project: it has a goal (the research question),
 * a team (the agents), a backlog (the tasks), and a deliverable (the report).
 */
export interface WorkforceSession {
  id: string;
  originalQuestion: string;
  tasks: Map<string, Task>;
  agents: Map<string, AgentInfo>;
  status: "running" | "completed" | "failed";
  finalReport: string | null;
  startedAt: Date;
  completedAt: Date | null;
}

// =============================================================================
// CONFIGURATION
// =============================================================================

/**
 * Runtime configuration for the workforce. Separated from code so you
 * can tweak behavior without editing agent logic.
 */
export interface WorkforceConfig {
  /** Claude model to use for all agents */
  model: string;
  /** Max tokens per Claude API call */
  maxTokens: number;
  /** Max retries per task before it's marked as failed */
  defaultMaxRetries: number;
  /** Total session timeout in milliseconds */
  sessionTimeoutMs: number;
  /** Max Claude API calls across the entire session (cost control) */
  maxApiCalls: number;
}

/**
 * Sensible defaults. These are conservative — you can increase them
 * once you're comfortable with the system's behavior and cost.
 */
export const DEFAULT_CONFIG: WorkforceConfig = {
  model: "claude-sonnet-4-20250514",
  maxTokens: 4096,
  defaultMaxRetries: 2,
  sessionTimeoutMs: 5 * 60 * 1000, // 5 minutes
  maxApiCalls: 30,
};
