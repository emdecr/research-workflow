/**
 * synthesizer.ts — The Synthesizer agent
 *
 * The Synthesizer is the final stage. It receives all research findings
 * and produces a coherent, well-structured report.
 *
 * KEY BEHAVIORS:
 * - Receives a task:assign with all research findings
 * - Uses Claude to merge, reconcile, and structure them into a report
 * - Can request more research if findings are critically insufficient
 * - Submits the final report which completes the entire session
 *
 * TOOL DEFINITIONS:
 * The Synthesizer has just two tools:
 *
 * - submit_report: Deliver the final synthesized report
 * - request_more_research: Send findings back with a request for deeper work
 *
 * The Synthesizer has the FEWEST tools. It's deliberately constrained
 * to producing output or requesting input — it can't create tasks,
 * evaluate individual findings, or interact with researchers directly.
 * All escalation goes through the Coordinator.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { AgentInfo, AgentMessage } from "../types.js";
import { MessageBus } from "../message-bus.js";
import { TaskManager } from "../task-manager.js";
import { BaseAgent, type ToolResult } from "./base-agent.js";
import { getSynthesizerPrompt } from "../prompts/synthesizer-prompt.js";
import { logAgentAction } from "../utils/logger.js";

export class SynthesizerAgent extends BaseAgent {
  /**
   * The Coordinator's info — needed to send requests for more research.
   */
  private coordinator: AgentInfo;

  /**
   * Track whether we've already requested more research.
   * We only allow this ONCE to prevent infinite loops between
   * the Synthesizer requesting more and the Coordinator creating
   * more tasks that produce the same insufficient results.
   */
  private hasRequestedMoreResearch = false;

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
    return getSynthesizerPrompt();
  }

  getTools(): Anthropic.Messages.Tool[] {
    return [
      {
        name: "submit_report",
        description:
          "Submit the final synthesized research report. This is the " +
          "deliverable of the entire research session. The report should " +
          "be well-structured with an executive summary, key findings, " +
          "analysis, contradictions/uncertainties, and conclusion.",
        input_schema: {
          type: "object" as const,
          properties: {
            report: {
              type: "string",
              description:
                "The complete synthesized report in markdown format.",
            },
          },
          required: ["report"],
        },
      },
      {
        name: "request_more_research",
        description:
          "Request additional research from the Coordinator. Use this " +
          "ONLY if there are critical gaps that prevent meaningful synthesis. " +
          "Be specific about what additional information is needed and why. " +
          "This can only be used once per session.",
        input_schema: {
          type: "object" as const,
          properties: {
            gaps: {
              type: "string",
              description:
                "Description of the critical gaps in the current research " +
                "and what additional investigation is needed.",
            },
          },
          required: ["gaps"],
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
      case "submit_report":
        return this.executeSubmitReport(toolInput, taskId);
      case "request_more_research":
        return this.executeRequestMoreResearch(toolInput, taskId);
      default:
        return { result: `Unknown tool: ${toolName}`, isError: true };
    }
  }

  async handleMessage(message: AgentMessage): Promise<void> {
    switch (message.type) {
      case "task:assign":
        await this.handleTaskAssignment(message);
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
   * Handle a synthesis task assignment.
   *
   * The message payload contains all research findings formatted by
   * the Coordinator. We pass everything to Claude and let it produce
   * the final report.
   */
  private async handleTaskAssignment(message: AgentMessage): Promise<void> {
    this.taskManager.updateTaskStatus(message.taskId, "in-progress");

    logAgentAction(this.info, "Beginning synthesis of research findings...");

    // Run the tool-use loop. Claude reads all findings and either
    // produces a report (submit_report) or requests more research
    // (request_more_research).
    await this.runToolLoop(
      message.taskId,
      `Please synthesize the following research into a coherent report ` +
        `using the submit_report tool.\n\n${message.payload}`
    );
  }

  // ===========================================================================
  // TOOL EXECUTION
  // ===========================================================================

  /**
   * Submit the final report.
   *
   * This is the culmination of the entire workforce session. The report
   * is stored in the task result and sent to the Coordinator, which
   * will complete the session.
   */
  private async executeSubmitReport(
    input: Record<string, unknown>,
    taskId: string
  ): Promise<ToolResult> {
    const report = input.report as string;

    // Mark the synthesis task as completed
    this.taskManager.updateTaskStatus(taskId, "completed", report);

    // Notify the Coordinator
    this.sendMessage("task:complete", this.coordinator, taskId, report);

    logAgentAction(this.info, "Final report submitted");

    return { result: "Report submitted successfully." };
  }

  /**
   * Request more research from the Coordinator.
   *
   * This is the Synthesizer's feedback loop — it can push back if
   * the findings aren't sufficient for a good report. But it can
   * only do this ONCE to prevent infinite loops.
   *
   * In practice, this is rarely triggered because the Coordinator
   * already evaluates findings before passing them to the Synthesizer.
   * But it's an important safety valve for cases where individually
   * acceptable findings don't collectively tell a coherent story.
   */
  private async executeRequestMoreResearch(
    input: Record<string, unknown>,
    taskId: string
  ): Promise<ToolResult> {
    const gaps = input.gaps as string;

    // Enforce the one-time limit
    if (this.hasRequestedMoreResearch) {
      return {
        result:
          "You have already requested more research once. Please work with " +
          "the findings you have and produce the best report possible. " +
          "Note any gaps in the Contradictions & Uncertainties section.",
        isError: true,
      };
    }

    this.hasRequestedMoreResearch = true;

    logAgentAction(this.info, `Requesting more research: "${gaps}"`);

    // Send the request to the Coordinator.
    // The Coordinator will handle creating new research tasks.
    this.sendMessage(
      "task:reject",
      this.coordinator,
      taskId,
      `Synthesizer requests more research:\n${gaps}`
    );

    return {
      result:
        "More research requested. The Coordinator will assign additional " +
        "research tasks. You will receive updated findings when available.",
    };
  }
}
