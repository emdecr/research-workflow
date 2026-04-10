/**
 * researcher.ts — The Researcher agent
 *
 * Researchers are the "workers" of the workforce. Each one receives
 * a specific research angle from the Coordinator, investigates it,
 * and submits findings.
 *
 * KEY BEHAVIORS:
 * - Receives a task:assign → investigates the angle via Claude
 * - Can ask for clarification → sends clarification:ask, waits for reply
 * - Submits findings → sends task:complete with results
 * - If rejected → retries with the feedback incorporated
 * - If unable → sends task:failed with explanation
 *
 * TOOL DEFINITIONS:
 * Researchers have three tools:
 *
 * - submit_finding: Submit completed research findings
 * - request_clarification: Ask the Coordinator a question
 * - report_inability: Report that the angle can't be researched
 *
 * Notice the Researcher has FEWER tools than the Coordinator.
 * This is intentional — Researchers don't create tasks or evaluate
 * other agents. Limiting tools limits scope, which keeps agents focused.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { AgentInfo, AgentMessage } from "../types.js";
import { MessageBus } from "../message-bus.js";
import { TaskManager } from "../task-manager.js";
import { BaseAgent, type ToolResult } from "./base-agent.js";
import { getResearcherPrompt } from "../prompts/researcher-prompt.js";
import { logAgentAction } from "../utils/logger.js";

export class ResearcherAgent extends BaseAgent {
  /**
   * The Coordinator's info — needed so we know who to send
   * clarification requests and findings to.
   */
  private coordinator: AgentInfo;

  constructor(
    info: AgentInfo,
    bus: MessageBus,
    taskManager: TaskManager,
    coordinator: AgentInfo
  ) {
    super(info, bus, taskManager);
    this.coordinator = coordinator;
  }

  // ===========================================================================
  // ABSTRACT METHOD IMPLEMENTATIONS
  // ===========================================================================

  getSystemPrompt(): string {
    return getResearcherPrompt(this.info.id);
  }

  getTools(): Anthropic.Messages.Tool[] {
    return [
      {
        name: "submit_finding",
        description:
          "Submit your research findings for the assigned angle. " +
          "Your findings should be thorough, well-structured, and " +
          "directly address the guiding questions. Include key points, " +
          "analysis, evidence, uncertainties, and relevance.",
        input_schema: {
          type: "object" as const,
          properties: {
            findings: {
              type: "string",
              description:
                "Your complete research findings. Use markdown formatting " +
                "for structure. Include Key Points, Analysis, Evidence, " +
                "Uncertainties, and Relevance sections.",
            },
          },
          required: ["findings"],
        },
      },
      {
        name: "request_clarification",
        description:
          "Ask the Coordinator for clarification about your research angle. " +
          "Use this if the angle is too vague, the scope is unclear, or " +
          "the guiding questions seem contradictory. Be specific about " +
          "what you need to know.",
        input_schema: {
          type: "object" as const,
          properties: {
            question: {
              type: "string",
              description:
                "Your specific clarification question for the Coordinator.",
            },
          },
          required: ["question"],
        },
      },
      {
        name: "report_inability",
        description:
          "Report that you cannot complete this research task. " +
          "Use this ONLY if the angle is fundamentally unanswerable " +
          "or requires information you genuinely cannot reason about. " +
          "This should be rare.",
        input_schema: {
          type: "object" as const,
          properties: {
            reason: {
              type: "string",
              description:
                "Explanation of why this research angle cannot be investigated.",
            },
          },
          required: ["reason"],
        },
      },
    ];
  }

  async executeTool(
    toolName: string,
    toolInput: Record<string, unknown>,
    taskId: string
  ): Promise<ToolResult> {
    switch (toolName) {
      case "submit_finding":
        return this.executeSubmitFinding(toolInput, taskId);
      case "request_clarification":
        return this.executeRequestClarification(toolInput, taskId);
      case "report_inability":
        return this.executeReportInability(toolInput, taskId);
      default:
        return { result: `Unknown tool: ${toolName}`, isError: true };
    }
  }

  async handleMessage(message: AgentMessage): Promise<void> {
    switch (message.type) {
      case "task:assign":
        await this.handleTaskAssignment(message);
        break;

      case "task:reject":
        await this.handleTaskRejection(message);
        break;

      case "clarification:reply":
        // Clarification replies are handled by waitForMessage() in
        // the clarification tool execution. We don't need to do
        // anything here — the promise resolves in executeRequestClarification.
        break;

      default:
        logAgentAction(
          this.info,
          `Ignoring unhandled message type: ${message.type}`
        );
    }
  }

  // ===========================================================================
  // MESSAGE HANDLERS
  // ===========================================================================

  /**
   * Handle a new task assignment from the Coordinator.
   *
   * This kicks off the research process: we send the research angle
   * and guiding questions to Claude via the tool-use loop, and Claude
   * investigates and calls submit_finding when done.
   */
  private async handleTaskAssignment(message: AgentMessage): Promise<void> {
    // Mark the task as in-progress
    this.taskManager.updateTaskStatus(message.taskId, "in-progress");

    logAgentAction(this.info, `Starting research on task ${message.taskId.slice(0, 8)}`);

    // Run the tool-use loop. Claude reads the research angle,
    // investigates it, and calls submit_finding with results.
    await this.runToolLoop(
      message.taskId,
      `You have been assigned a research task. Please investigate the following ` +
        `and submit your findings using the submit_finding tool.\n\n${message.payload}`
    );
  }

  /**
   * Handle a rejection — the Coordinator wasn't satisfied with our findings.
   *
   * We pass the rejection feedback to Claude so it can improve
   * the findings and try again.
   *
   * IMPORTANT: We append to the EXISTING conversation history.
   * Claude sees its previous attempt AND the rejection feedback,
   * so it knows exactly what to improve. This is much better than
   * starting from scratch — it produces targeted improvements
   * instead of completely different (and possibly worse) output.
   */
  private async handleTaskRejection(message: AgentMessage): Promise<void> {
    logAgentAction(
      this.info,
      `Task ${message.taskId.slice(0, 8)} was rejected, retrying with feedback`
    );

    // Run the tool-use loop with the rejection feedback.
    // Because the conversation history already contains the previous
    // attempt, Claude can see what it wrote before and what was wrong.
    await this.runToolLoop(
      message.taskId,
      `Your previous findings were rejected by the Coordinator. ` +
        `Here is their feedback:\n\n"${message.payload}"\n\n` +
        `Please address these specific issues and submit improved findings ` +
        `using the submit_finding tool. Focus on the gaps identified — ` +
        `don't rewrite everything, just improve the weak areas.`
    );
  }

  // ===========================================================================
  // TOOL EXECUTION
  // ===========================================================================

  /**
   * Submit research findings.
   *
   * This marks the task as completed and sends the findings to
   * the Coordinator for evaluation.
   */
  private async executeSubmitFinding(
    input: Record<string, unknown>,
    taskId: string
  ): Promise<ToolResult> {
    const findings = input.findings as string;

    // Mark the task as completed with the findings
    this.taskManager.updateTaskStatus(taskId, "completed", findings);

    // Notify the Coordinator that this task is done
    const task = this.taskManager.getTask(taskId);
    if (task) {
      this.sendMessage(
        "task:complete",
        task.createdBy, // always the Coordinator
        taskId,
        findings
      );
    }

    return {
      result:
        "Findings submitted successfully. The Coordinator will evaluate them.",
    };
  }

  /**
   * Request clarification from the Coordinator.
   *
   * This sends a question and WAITS for the reply using the message
   * bus's waitForMessage(). The tool-use loop pauses here until the
   * Coordinator responds.
   *
   * This is a great example of agent-to-agent collaboration: the
   * Researcher realizes it needs more info, asks, receives an answer,
   * and continues — all autonomously within the tool-use loop.
   */
  private async executeRequestClarification(
    input: Record<string, unknown>,
    taskId: string
  ): Promise<ToolResult> {
    const question = input.question as string;

    logAgentAction(this.info, `Requesting clarification: "${question}"`);

    // Send the question to the Coordinator
    this.sendMessage(
      "clarification:ask",
      this.coordinator,
      taskId,
      question
    );

    // Wait for the reply. This is a blocking wait (Promise-based) —
    // the tool-use loop pauses until the Coordinator responds.
    // The 60-second timeout prevents hanging forever.
    try {
      const reply = await this.bus.waitForMessage(
        this.info.id,
        "clarification:reply",
        taskId,
        60_000
      );

      return {
        result:
          `Clarification from Coordinator: ${reply.payload}\n\n` +
          `Use this information to continue your research.`,
      };
    } catch {
      return {
        result:
          "Clarification request timed out. Proceed with your best interpretation.",
        isError: true,
      };
    }
  }

  /**
   * Report that this research angle cannot be completed.
   */
  private async executeReportInability(
    input: Record<string, unknown>,
    taskId: string
  ): Promise<ToolResult> {
    const reason = input.reason as string;

    // Mark the task as failed
    this.taskManager.updateTaskStatus(taskId, "failed");

    // Notify the Coordinator
    const task = this.taskManager.getTask(taskId);
    if (task) {
      this.sendMessage("task:failed", task.createdBy, taskId, reason);
    }

    return { result: "Inability reported. The Coordinator has been notified." };
  }
}
