/**
 * logger.ts — Color-coded console output for the agent workforce
 *
 * In a multi-agent system, understanding what's happening is HARD.
 * Multiple agents run concurrently, send messages, process tasks,
 * and call Claude. Without clear logging, debugging is a nightmare.
 *
 * This logger color-codes output by agent role so you can visually
 * track each agent's activity in the terminal. It also logs every
 * message and task transition, creating a human-readable trace of
 * the entire workforce session.
 */

import type { AgentInfo, AgentMessage, AgentRole, TaskStatus } from "../types.js";

// =============================================================================
// ANSI COLOR CODES
// =============================================================================

/**
 * Terminal color codes. We use these directly instead of a library
 * like chalk — it's one less dependency and you can see exactly
 * how terminal colors work.
 *
 * The pattern is: \x1b[<code>m ... \x1b[0m
 * The first part sets the color, the second resets to default.
 */
const COLORS = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",

  // Agent role colors — chosen for visual distinction
  blue: "\x1b[34m", // Coordinator: commands and delegates
  green: "\x1b[32m", // Researcher: does the work
  yellow: "\x1b[33m", // Synthesizer: produces the output

  // Status colors
  red: "\x1b[31m", // Errors and failures
  cyan: "\x1b[36m", // Info and metadata
  magenta: "\x1b[35m", // Messages between agents
} as const;

/**
 * Maps each agent role to a color for consistent visual identification.
 */
const ROLE_COLORS: Record<AgentRole, string> = {
  coordinator: COLORS.blue,
  researcher: COLORS.green,
  synthesizer: COLORS.yellow,
};

/**
 * Short emoji-free labels for each role, padded for alignment.
 * Keeping output aligned makes logs much easier to scan.
 */
const ROLE_LABELS: Record<AgentRole, string> = {
  coordinator: "COORD",
  researcher: "RSRCH",
  synthesizer: "SYNTH",
};

// =============================================================================
// FORMATTING HELPERS
// =============================================================================

/** Returns a formatted timestamp like "12:34:56.789" */
function timestamp(): string {
  return new Date().toISOString().split("T")[1].replace("Z", "");
}

/** Formats an agent's identity as a colored tag like "[COORD coordinator-1]" */
function agentTag(agent: AgentInfo): string {
  const color = ROLE_COLORS[agent.role];
  const label = ROLE_LABELS[agent.role];
  return `${color}[${label} ${agent.id}]${COLORS.reset}`;
}

/** Truncates a string to maxLen characters, adding "..." if truncated */
function truncate(str: string, maxLen: number = 120): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + "...";
}

// =============================================================================
// PUBLIC LOGGING FUNCTIONS
// =============================================================================

/**
 * Log a message being sent between agents.
 * This is the most important log — it shows the "conversation" between agents.
 *
 * Example output:
 *   12:34:56.789 ✉ [COORD coordinator-1] → [RSRCH researcher-2] task:assign
 *                  "Investigate the economic impact of quantum computing"
 */
export function logMessage(message: AgentMessage): void {
  const time = `${COLORS.dim}${timestamp()}${COLORS.reset}`;
  const from = agentTag(message.from);
  const to = agentTag(message.to);
  const type = `${COLORS.magenta}${message.type}${COLORS.reset}`;
  const payload = `${COLORS.dim}"${truncate(message.payload)}"${COLORS.reset}`;

  console.log(`${time} ${COLORS.magenta}MSG${COLORS.reset} ${from} -> ${to} ${type}`);
  console.log(`         ${payload}`);
}

/**
 * Log a task status change.
 * Shows the task tree relationship via parentTaskId.
 *
 * Example output:
 *   12:34:56.789 TSK [task-abc123] pending → in-progress
 *                  "Research angle: economic impact"
 */
export function logTaskUpdate(
  taskId: string,
  oldStatus: TaskStatus | null,
  newStatus: TaskStatus,
  description: string
): void {
  const time = `${COLORS.dim}${timestamp()}${COLORS.reset}`;

  // Color the new status based on what it means
  const statusColors: Record<TaskStatus, string> = {
    pending: COLORS.dim,
    "in-progress": COLORS.cyan,
    completed: COLORS.green,
    rejected: COLORS.yellow,
    failed: COLORS.red,
  };

  const transition = oldStatus
    ? `${COLORS.dim}${oldStatus}${COLORS.reset} -> ${statusColors[newStatus]}${newStatus}${COLORS.reset}`
    : `${statusColors[newStatus]}${newStatus}${COLORS.reset}`;

  console.log(`${time} ${COLORS.cyan}TSK${COLORS.reset} [${taskId.slice(0, 8)}] ${transition}`);
  console.log(`         ${COLORS.dim}"${truncate(description)}"${COLORS.reset}`);
}

/**
 * Log a Claude API call.
 * Tracks token usage so you can monitor costs.
 *
 * Example output:
 *   12:34:56.789 API [COORD coordinator-1] tokens: 1234 in / 567 out
 */
export function logApiCall(
  agent: AgentInfo,
  inputTokens: number,
  outputTokens: number
): void {
  const time = `${COLORS.dim}${timestamp()}${COLORS.reset}`;
  const tag = agentTag(agent);
  const tokens = `${COLORS.dim}tokens: ${inputTokens} in / ${outputTokens} out${COLORS.reset}`;

  console.log(`${time} ${COLORS.bold}API${COLORS.reset} ${tag} ${tokens}`);
}

/**
 * Log a general agent action or decision.
 * Use this for important moments that aren't messages or task updates.
 *
 * Example output:
 *   12:34:56.789 [RSRCH researcher-2] Requesting clarification from coordinator
 */
export function logAgentAction(agent: AgentInfo, action: string): void {
  const time = `${COLORS.dim}${timestamp()}${COLORS.reset}`;
  const tag = agentTag(agent);

  console.log(`${time} ${tag} ${action}`);
}

/**
 * Log a system-level event (session start, completion, errors).
 *
 * Example output:
 *   12:34:56.789 SYS Session started: "What are the implications of..."
 */
export function logSystem(message: string): void {
  const time = `${COLORS.dim}${timestamp()}${COLORS.reset}`;
  console.log(`${time} ${COLORS.bold}SYS${COLORS.reset} ${message}`);
}

/**
 * Log an error with red highlighting.
 */
export function logError(message: string, error?: unknown): void {
  const time = `${COLORS.dim}${timestamp()}${COLORS.reset}`;
  console.log(`${time} ${COLORS.red}ERR${COLORS.reset} ${message}`);
  if (error instanceof Error) {
    console.log(`         ${COLORS.red}${error.message}${COLORS.reset}`);
  }
}
