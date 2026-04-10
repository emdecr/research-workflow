/**
 * coordinator.ts — The Coordinator agent
 *
 * The Coordinator is the "supervisor" of the workforce. It:
 * 1. Receives the research question
 * 2. Calls Claude to decompose it into research angles
 * 3. Creates sub-tasks and assigns them to Researchers
 * 4. Evaluates each Researcher's findings (accept or reject)
 * 5. Once all research is done, triggers the Synthesizer
 *
 * The Coordinator does NOT do research itself — it manages the process.
 * Think of it as a project manager: it breaks down the work, delegates,
 * reviews quality, and coordinates handoffs.
 *
 * TOOL DEFINITIONS:
 * The Coordinator has three tools that Claude can call:
 *
 * - create_research_task: Spawn a sub-task for a Researcher.
 *   Claude decides how many angles to create and what each one covers.
 *
 * - evaluate_finding: Assess a Researcher's output.
 *   Claude decides if it's good enough or needs revision.
 *
 * - request_synthesis: Send all findings to the Synthesizer.
 *   Claude calls this when all research is complete.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { AgentInfo, AgentMessage } from "../types.js";
import { MessageBus } from "../message-bus.js";
import { TaskManager } from "../task-manager.js";
import { BaseAgent, type ToolResult } from "./base-agent.js";
import { getCoordinatorPrompt } from "../prompts/coordinator-prompt.js";
import { logAgentAction, logError } from "../utils/logger.js";

export class CoordinatorAgent extends BaseAgent {
  /**
   * The original research question this coordinator is managing.
   */
  private researchQuestion: string;

  /**
   * Available researcher agents. The coordinator needs to know
   * who it can assign work to.
   */
  private researchers: AgentInfo[];

  /**
   * The synthesizer agent. The coordinator sends the final
   * compilation of findings here.
   */
  private synthesizer: AgentInfo;

  /**
   * The root task ID — the top-level task that represents
   * the entire research question.
   */
  private rootTaskId: string | null = null;

  /**
   * Tracks which researcher is assigned to which task.
   * Used to round-robin task assignments across available researchers.
   */
  private nextResearcherIndex = 0;

  constructor(
    info: AgentInfo,
    bus: MessageBus,
    taskManager: TaskManager,
    researchQuestion: string,
    researchers: AgentInfo[],
    synthesizer: AgentInfo
  ) {
    super(info, bus, taskManager);
    this.researchQuestion = researchQuestion;
    this.researchers = researchers;
    this.synthesizer = synthesizer;
  }

  // ===========================================================================
  // ABSTRACT METHOD IMPLEMENTATIONS
  // ===========================================================================

  getSystemPrompt(): string {
    return getCoordinatorPrompt(this.researchQuestion, this.researchers.length);
  }

  /**
   * The Coordinator's tools. These define what Claude can DO as the
   * Coordinator. Each tool has:
   * - name: how Claude references it
   * - description: helps Claude understand when to use it
   * - input_schema: JSON Schema for the tool's parameters
   *
   * Notice how the descriptions are written for CLAUDE to read,
   * not for a human developer. They explain the purpose and
   * constraints in natural language.
   */
  getTools(): Anthropic.Messages.Tool[] {
    return [
      {
        name: "create_research_task",
        description:
          "Create a research task for one of your Researcher agents. " +
          "Each task should focus on a single, distinct angle of the " +
          "research question. Include specific guiding questions to " +
          "direct the researcher's investigation.",
        input_schema: {
          type: "object" as const,
          properties: {
            angle: {
              type: "string",
              description:
                "The specific research angle to investigate. Be specific and focused.",
            },
            guiding_questions: {
              type: "array",
              items: { type: "string" },
              description:
                "2-4 specific questions the researcher should answer when investigating this angle.",
            },
          },
          required: ["angle", "guiding_questions"],
        },
      },
      {
        name: "evaluate_finding",
        description:
          "Evaluate a researcher's findings. Call this to either ACCEPT " +
          "the finding (if it adequately covers the angle) or REJECT it " +
          "(if it needs more work). When rejecting, provide specific, " +
          "actionable feedback about what's missing or insufficient.",
        input_schema: {
          type: "object" as const,
          properties: {
            task_id: {
              type: "string",
              description: "The ID of the research task being evaluated.",
            },
            acceptable: {
              type: "boolean",
              description:
                "true if the finding is adequate, false if it needs revision.",
            },
            feedback: {
              type: "string",
              description:
                "If rejecting: specific feedback about what's missing. " +
                "If accepting: brief note about what was good (optional).",
            },
          },
          required: ["task_id", "acceptable"],
        },
      },
      {
        name: "request_synthesis",
        description:
          "Send all completed research findings to the Synthesizer agent " +
          "to produce the final report. Call this ONLY after all research " +
          "tasks are completed or have failed after retries.",
        input_schema: {
          type: "object" as const,
          properties: {
            summary_of_findings: {
              type: "string",
              description:
                "A brief summary of what was researched and any notes about " +
                "gaps or failed research angles the synthesizer should be aware of.",
            },
          },
          required: ["summary_of_findings"],
        },
      },
    ];
  }

  /**
   * Execute a tool that Claude called.
   *
   * This is where the Coordinator's actions actually happen.
   * Claude says "call create_research_task with these params"
   * and this method creates the task and sends the assignment message.
   */
  async executeTool(
    toolName: string,
    toolInput: Record<string, unknown>,
    taskId: string
  ): Promise<ToolResult> {
    switch (toolName) {
      case "create_research_task":
        return this.executeCreateResearchTask(toolInput, taskId);
      case "evaluate_finding":
        return this.executeEvaluateFinding(toolInput);
      case "request_synthesis":
        return this.executeRequestSynthesis(toolInput, taskId);
      default:
        return { result: `Unknown tool: ${toolName}`, isError: true };
    }
  }

  /**
   * Handle incoming messages.
   *
   * The Coordinator receives:
   * - task:assign    → the initial assignment (start decomposing)
   * - task:complete  → a Researcher finished their work (evaluate it)
   * - task:failed    → a Researcher couldn't complete their work
   * - clarification:ask → a Researcher needs more info
   */
  async handleMessage(message: AgentMessage): Promise<void> {
    switch (message.type) {
      case "task:assign":
        await this.handleTaskAssignment(message);
        break;

      case "task:complete":
        await this.handleTaskCompletion(message);
        break;

      case "task:failed":
        await this.handleTaskFailure(message);
        break;

      case "clarification:ask":
        await this.handleClarificationRequest(message);
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
   * Handle the initial task assignment — this kicks off the whole process.
   *
   * The Coordinator receives the research question and uses Claude
   * (via the tool-use loop) to decompose it into research angles.
   * Claude will call create_research_task for each angle it identifies.
   */
  private async handleTaskAssignment(message: AgentMessage): Promise<void> {
    this.rootTaskId = message.taskId;

    // Update the root task to in-progress
    this.taskManager.updateTaskStatus(message.taskId, "in-progress");

    logAgentAction(this.info, "Decomposing research question into angles...");

    // Run the tool-use loop. Claude will read the research question
    // (from the system prompt) and call create_research_task for
    // each angle it wants to investigate.
    await this.runToolLoop(
      message.taskId,
      `Please analyze the research question and create research tasks for your team. ` +
        `Break the question into distinct angles and create one task per angle using ` +
        `the create_research_task tool. Create all tasks now.`
    );
  }

  /**
   * Handle a Researcher completing their task.
   *
   * When a finding comes in, the Coordinator uses Claude to evaluate
   * whether it's good enough. Claude calls evaluate_finding with
   * acceptable=true or acceptable=false.
   */
  private async handleTaskCompletion(message: AgentMessage): Promise<void> {
    const task = this.taskManager.getTask(message.taskId);
    if (!task) return;

    logAgentAction(
      this.info,
      `Evaluating finding for: "${task.description}"`
    );

    // Use Claude to evaluate the quality of the finding.
    // We pass both the original task description and the result
    // so Claude has full context for evaluation.
    await this.runToolLoop(
      message.taskId,
      `A researcher has submitted findings for the task: "${task.description}"\n\n` +
        `FINDINGS:\n${message.payload}\n\n` +
        `Please evaluate these findings using the evaluate_finding tool. ` +
        `The task ID is: ${message.taskId}\n` +
        `Consider: Does it address the angle? Is it substantive? Are there obvious gaps?`
    );
  }

  /**
   * Handle a Researcher failing their task.
   *
   * When a task fails (exhausted retries or reported inability),
   * check if all sub-tasks are done. If so, proceed to synthesis
   * with whatever findings we have.
   */
  private async handleTaskFailure(message: AgentMessage): Promise<void> {
    const task = this.taskManager.getTask(message.taskId);
    logAgentAction(
      this.info,
      `Research task failed: "${task?.description ?? message.taskId}"`
    );

    await this.checkIfReadyForSynthesis();
  }

  /**
   * Handle a clarification request from a Researcher.
   *
   * The Coordinator uses Claude to answer the question, drawing on
   * its understanding of the overall research question.
   */
  private async handleClarificationRequest(
    message: AgentMessage
  ): Promise<void> {
    logAgentAction(
      this.info,
      `Answering clarification from ${message.from.id}`
    );

    // Use Claude to formulate a helpful reply
    const reply = await this.runToolLoop(
      message.taskId,
      `A researcher (${message.from.id}) is asking for clarification:\n\n` +
        `"${message.payload}"\n\n` +
        `Please provide a helpful clarification based on the research question. ` +
        `Respond with just the clarification text — do not use any tools.`
    );

    // Send the reply back to the Researcher
    this.sendMessage(
      "clarification:reply",
      message.from,
      message.taskId,
      reply
    );
  }

  // ===========================================================================
  // TOOL EXECUTION
  // ===========================================================================

  /**
   * Create a research sub-task and assign it to the next available Researcher.
   *
   * This is called when Claude decides to create a research task.
   * We pick a Researcher (round-robin), create the task in the
   * TaskManager, and send a task:assign message to the Researcher.
   */
  private async executeCreateResearchTask(
    input: Record<string, unknown>,
    parentTaskId: string
  ): Promise<ToolResult> {
    const angle = input.angle as string;
    const guidingQuestions = input.guiding_questions as string[];

    // Pick the next researcher (round-robin assignment)
    const researcher = this.researchers[this.nextResearcherIndex];
    this.nextResearcherIndex =
      (this.nextResearcherIndex + 1) % this.researchers.length;

    // Create the task in the task manager
    const task = this.taskManager.createTask({
      parentTaskId,
      assignedTo: researcher,
      createdBy: this.info,
      description: `Research angle: ${angle}`,
      input: this.formatResearchInput(angle, guidingQuestions),
    });

    // Send the assignment to the researcher via the message bus
    this.sendMessage("task:assign", researcher, task.id, task.input);

    return {
      result:
        `Research task created (${task.id.slice(0, 8)}) and assigned to ${researcher.id}. ` +
        `Angle: "${angle}"`,
    };
  }

  /**
   * Evaluate a researcher's finding — accept or reject.
   */
  private async executeEvaluateFinding(
    input: Record<string, unknown>
  ): Promise<ToolResult> {
    const taskId = input.task_id as string;
    const acceptable = input.acceptable as boolean;
    const feedback = (input.feedback as string) ?? "";

    const task = this.taskManager.getTask(taskId);
    if (!task) {
      return { result: `Task not found: ${taskId}`, isError: true };
    }

    if (acceptable) {
      // Accept the finding — mark task as completed
      // (It's already completed from the Researcher's side, so we
      // just log the acceptance and check if we can move on)
      logAgentAction(this.info, `Accepted finding for: "${task.description}"`);

      await this.checkIfReadyForSynthesis();

      return { result: `Finding accepted for task ${taskId.slice(0, 8)}.` };
    } else {
      // Reject the finding — send it back for revision
      logAgentAction(
        this.info,
        `Rejected finding for: "${task.description}" — ${feedback}`
      );

      // Update task status to rejected
      this.taskManager.updateTaskStatus(taskId, "rejected", undefined, feedback);

      // Try to retry the task
      const retried = this.taskManager.retryTask(taskId);

      if (retried && retried.status === "in-progress") {
        // Send rejection feedback to the researcher so they can improve
        this.sendMessage("task:reject", task.assignedTo, taskId, feedback);

        return {
          result:
            `Finding rejected for task ${taskId.slice(0, 8)}. ` +
            `Feedback sent to ${task.assignedTo.id}. ` +
            `Retry ${retried.retryCount}/${retried.maxRetries}.`,
        };
      } else {
        // Retries exhausted — task is now failed
        logAgentAction(
          this.info,
          `Task ${taskId.slice(0, 8)} failed after max retries`
        );

        await this.checkIfReadyForSynthesis();

        return {
          result:
            `Task ${taskId.slice(0, 8)} has exhausted retries and is now failed.`,
        };
      }
    }
  }

  /**
   * Collect all findings and send them to the Synthesizer.
   */
  private async executeRequestSynthesis(
    input: Record<string, unknown>,
    parentTaskId: string
  ): Promise<ToolResult> {
    const summaryOfFindings = input.summary_of_findings as string;

    if (!this.rootTaskId) {
      return { result: "No root task ID set", isError: true };
    }

    // Collect all completed research findings
    const completedTasks =
      this.taskManager.getCompletedSubTasks(this.rootTaskId);

    if (completedTasks.length === 0) {
      return {
        result: "No completed research tasks found. Cannot synthesize.",
        isError: true,
      };
    }

    // Format all findings into a single input for the Synthesizer
    const findingsText = completedTasks
      .map(
        (task, i) =>
          `## Finding ${i + 1}: ${task.description}\n\n${task.result ?? "(no result)"}`
      )
      .join("\n\n---\n\n");

    const synthesisInput =
      `# Research Synthesis Request\n\n` +
      `## Original Question\n${this.researchQuestion}\n\n` +
      `## Coordinator's Notes\n${summaryOfFindings}\n\n` +
      `## Research Findings\n\n${findingsText}`;

    // Create a synthesis task
    const synthesisTask = this.taskManager.createTask({
      parentTaskId: this.rootTaskId,
      assignedTo: this.synthesizer,
      createdBy: this.info,
      description: "Synthesize research findings into final report",
      input: synthesisInput,
    });

    // Send to the synthesizer
    this.sendMessage(
      "task:assign",
      this.synthesizer,
      synthesisTask.id,
      synthesisInput
    );

    return {
      result:
        `Synthesis task created (${synthesisTask.id.slice(0, 8)}) with ` +
        `${completedTasks.length} findings. Assigned to ${this.synthesizer.id}.`,
    };
  }

  // ===========================================================================
  // HELPERS
  // ===========================================================================

  /**
   * Check if all research sub-tasks are done and we can move to synthesis.
   *
   * This is called after every task completion or failure. When all
   * sub-tasks are in a terminal state, we trigger a synthesis pass
   * through Claude so it can call request_synthesis.
   */
  private async checkIfReadyForSynthesis(): Promise<void> {
    if (!this.rootTaskId) return;

    // Get sub-tasks, but exclude any synthesis task that may already exist
    const subTasks = this.taskManager.getSubTasks(this.rootTaskId);
    const researchTasks = subTasks.filter(
      (t) => !t.description.includes("Synthesize")
    );

    if (researchTasks.length === 0) return;

    const allDone = researchTasks.every(
      (t) => t.status === "completed" || t.status === "failed"
    );

    if (!allDone) return;

    logAgentAction(this.info, "All research tasks done — requesting synthesis");

    // Let Claude review what we have and call request_synthesis
    const completed = researchTasks.filter((t) => t.status === "completed");
    const failed = researchTasks.filter((t) => t.status === "failed");

    await this.runToolLoop(
      this.rootTaskId,
      `All research tasks are complete.\n` +
        `- ${completed.length} completed successfully\n` +
        `- ${failed.length} failed\n\n` +
        `Please use the request_synthesis tool to send the findings to the Synthesizer. ` +
        `Include a brief summary and note any gaps from failed tasks.`
    );
  }

  /**
   * Format the research angle and guiding questions into a clear
   * input string for the Researcher.
   */
  private formatResearchInput(
    angle: string,
    guidingQuestions: string[]
  ): string {
    const questions = guidingQuestions
      .map((q, i) => `${i + 1}. ${q}`)
      .join("\n");

    return (
      `## Research Angle\n${angle}\n\n` +
      `## Guiding Questions\n${questions}\n\n` +
      `Investigate this angle thoroughly and submit your findings.`
    );
  }
}
