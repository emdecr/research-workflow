/**
 * base-agent.ts — The engine that makes agents think
 *
 * This is the most important file in the codebase. It implements the
 * Claude API "tool-use loop" — the core pattern that turns a language
 * model into an autonomous agent.
 *
 * THE TOOL-USE LOOP EXPLAINED:
 *
 * A regular Claude API call is stateless: you send a prompt, get a response.
 * But an AGENT needs to take actions in the world — create tasks, send
 * messages, evaluate results. The tool-use loop makes this possible:
 *
 *   1. You send Claude a message along with TOOL DEFINITIONS
 *      (descriptions of actions the agent can take)
 *
 *   2. Claude responds. Two possible outcomes:
 *      a) stop_reason = "end_turn" → Claude is done talking, loop ends
 *      b) stop_reason = "tool_use" → Claude wants to call a tool
 *
 *   3. If Claude wants to call a tool:
 *      a) Extract the tool name and input from Claude's response
 *      b) Execute the tool in YOUR code (e.g., create a task, send a message)
 *      c) Send the tool's result back to Claude as a "tool_result" message
 *      d) Go back to step 2
 *
 * This loop is what gives agents AUTONOMY. You don't tell Claude which
 * tools to call or in what order — Claude decides based on the system
 * prompt, the conversation history, and the tool definitions. Your code
 * just provides the tools and executes them when Claude asks.
 *
 * WHAT THIS FILE PROVIDES:
 *
 * The BaseAgent class handles all the shared mechanics:
 * - Subscribing to the message bus
 * - Running the tool-use loop
 * - Managing conversation history per task
 * - Tracking API call limits
 *
 * Each agent role (Coordinator, Researcher, Synthesizer) extends this
 * class and provides:
 * - A system prompt (what the agent's "personality" and instructions are)
 * - Tool definitions (what actions the agent can take)
 * - Tool execution logic (what happens when Claude calls each tool)
 * - Message handling (what to do when a message arrives)
 */

import Anthropic from "@anthropic-ai/sdk";
import type { AgentInfo, AgentMessage, MessageType, WorkforceConfig } from "../types.js";
import { DEFAULT_CONFIG } from "../types.js";
import { MessageBus } from "../message-bus.js";
import { TaskManager } from "../task-manager.js";
import {
  client,
  incrementApiCallCount,
  getApiCallCount,
} from "../utils/claude-client.js";
import {
  logAgentAction,
  logApiCall,
  logError,
} from "../utils/logger.js";

// =============================================================================
// TYPES FOR THE TOOL-USE LOOP
// =============================================================================

/**
 * The result of executing a tool. This gets sent back to Claude
 * as a "tool_result" content block so it knows what happened.
 *
 * Why a string? Because Claude processes text. Even if your tool
 * returns structured data, you serialize it to a string for Claude
 * to interpret. Claude is very good at parsing structured text
 * (JSON, markdown, etc.) so this works well in practice.
 */
export interface ToolResult {
  /** The result content to send back to Claude */
  result: string;
  /** If true, tells Claude the tool call failed */
  isError?: boolean;
}

// =============================================================================
// BASE AGENT CLASS
// =============================================================================

export abstract class BaseAgent {
  /**
   * This agent's identity — its unique ID and role.
   * Set once during construction, never changes.
   */
  readonly info: AgentInfo;

  /**
   * The message bus this agent communicates through.
   * Shared with all other agents in the workforce.
   */
  protected bus: MessageBus;

  /**
   * The task manager that tracks work state.
   * Shared with all other agents in the workforce.
   */
  protected taskManager: TaskManager;

  /**
   * Configuration (model, token limits, etc.)
   */
  protected config: WorkforceConfig;

  /**
   * Conversation history PER TASK.
   *
   * Why per-task and not per-agent? Because an agent might work on
   * multiple tasks (a Researcher could be assigned several angles).
   * Each task needs its own conversation context — the Claude messages
   * for "research economic impact" shouldn't bleed into "research
   * regulatory landscape."
   *
   * The key is the task ID, the value is the array of messages
   * sent to/from Claude for that task.
   */
  private conversationHistories: Map<string, Anthropic.MessageParam[]> =
    new Map();

  constructor(
    info: AgentInfo,
    bus: MessageBus,
    taskManager: TaskManager,
    config?: Partial<WorkforceConfig>
  ) {
    this.info = info;
    this.bus = bus;
    this.taskManager = taskManager;
    this.config = { ...DEFAULT_CONFIG, ...config };

    // Subscribe to messages addressed to this agent.
    // All incoming messages go through handleMessage(), which
    // subclasses implement to route by message type.
    this.bus.subscribe(this.info.id, (message) => {
      // We wrap in a try/catch because handleMessage is async
      // and we don't want unhandled promise rejections crashing
      // the whole system. Errors are logged, not thrown.
      this.handleMessage(message).catch((err) => {
        logError(`Agent ${this.info.id} error handling message`, err);
      });
    });

    // Register with the task manager so it knows this agent exists
    this.taskManager.registerAgent(this.info);
  }

  // ===========================================================================
  // ABSTRACT METHODS — Subclasses must implement these
  // ===========================================================================

  /**
   * The system prompt that defines this agent's role, personality,
   * and instructions. This is the most important lever for controlling
   * agent behavior — the same code with different system prompts
   * produces completely different agents.
   */
  abstract getSystemPrompt(): string;

  /**
   * The tools available to this agent. Each tool is an action Claude
   * can decide to take. The tool definitions tell Claude:
   * - What the tool does (description)
   * - What inputs it needs (input_schema)
   *
   * Claude reads these definitions and decides which tool to call
   * based on the current conversation context.
   *
   * IMPORTANT: Tool definitions are the boundary between autonomy
   * and control. The more tools you give an agent, the more autonomous
   * it is. Limiting tools limits what the agent can do — which is
   * sometimes exactly what you want.
   */
  abstract getTools(): Anthropic.Messages.Tool[];

  /**
   * Execute a tool that Claude has decided to call.
   *
   * This is where agent actions actually happen — creating tasks,
   * sending messages, evaluating results, etc. The method receives
   * the tool name and the input Claude provided, and returns the
   * result to send back to Claude.
   *
   * @param toolName  - Which tool Claude wants to call
   * @param toolInput - The arguments Claude provided (parsed from JSON)
   * @param taskId    - The task this tool call is part of (for context)
   */
  abstract executeTool(
    toolName: string,
    toolInput: Record<string, unknown>,
    taskId: string
  ): Promise<ToolResult>;

  /**
   * Handle an incoming message from the bus.
   *
   * Each agent role implements this to respond to different message
   * types. For example, a Researcher handles:
   * - task:assign → start working on the task
   * - task:reject → retry with feedback
   * - clarification:reply → continue work with new info
   */
  abstract handleMessage(message: AgentMessage): Promise<void>;

  // ===========================================================================
  // THE TOOL-USE LOOP — The core engine
  // ===========================================================================

  /**
   * Run the tool-use loop for a given task.
   *
   * This is the heart of the agent. Here's what happens:
   *
   * 1. Build the message list: system prompt + conversation history + new user message
   * 2. Call Claude with the messages and tool definitions
   * 3. Process Claude's response:
   *    - If Claude returned text → extract it, we might be done
   *    - If Claude called tool(s) → execute them, add results to history
   * 4. If stop_reason is "tool_use" → loop back to step 2
   * 5. If stop_reason is "end_turn" → return Claude's final text
   *
   * The loop continues until Claude stops calling tools. This is the
   * AUTONOMY mechanism: Claude decides when it's gathered enough info,
   * taken enough actions, and is ready to provide a final answer.
   *
   * @param taskId  - The task to work on (used to key conversation history)
   * @param message - The initial message to send Claude (e.g., "Research this angle: ...")
   * @returns       - Claude's final text response after all tool calls are done
   */
  protected async runToolLoop(
    taskId: string,
    message: string
  ): Promise<string> {
    // Get or create the conversation history for this task
    const history = this.getHistory(taskId);

    // Add the new user message to the history.
    // "user" messages are what you send TO Claude.
    // "assistant" messages are what Claude sends back.
    history.push({
      role: "user" as const,
      content: message,
    });

    // The loop — keeps running until Claude says it's done
    while (true) {
      // --- SAFETY CHECK: API call limit ---
      // This prevents runaway agents from burning through your API budget.
      // The limit is session-wide, not per-agent.
      const callCount = incrementApiCallCount();
      if (callCount > this.config.maxApiCalls) {
        throw new Error(
          `API call limit reached (${this.config.maxApiCalls}). ` +
            `Session has made ${callCount} calls.`
        );
      }

      // --- STEP 1: Call Claude ---
      logAgentAction(this.info, `Calling Claude (API call #${callCount})`);

      const response = await client.messages.create({
        model: this.config.model,
        max_tokens: this.config.maxTokens,
        system: this.getSystemPrompt(),
        tools: this.getTools(),
        messages: history,
      });

      // Log token usage for cost tracking
      logApiCall(
        this.info,
        response.usage.input_tokens,
        response.usage.output_tokens
      );

      // --- STEP 2: Process the response ---
      //
      // Claude's response is an array of "content blocks." Each block is
      // either text or a tool call. A single response can contain MULTIPLE
      // blocks — e.g., some text explaining what it's about to do, followed
      // by a tool call.
      //
      // We need to:
      // a) Collect any text blocks (Claude's reasoning/commentary)
      // b) Execute any tool_use blocks
      // c) Build tool_result blocks to send back

      // Add Claude's full response to history as an assistant message
      history.push({
        role: "assistant" as const,
        content: response.content,
      });

      // If Claude is done (no more tool calls), extract and return the text
      if (response.stop_reason === "end_turn") {
        const textBlocks = response.content.filter(
          (block): block is Anthropic.Messages.TextBlock =>
            block.type === "text"
        );
        const finalText = textBlocks.map((b) => b.text).join("\n");

        logAgentAction(this.info, `Finished tool loop for task ${taskId.slice(0, 8)}`);
        return finalText;
      }

      // --- STEP 3: Execute tool calls ---
      //
      // Claude wants to call one or more tools. We execute each one
      // and collect the results. Then we add ALL results as a single
      // "user" message with tool_result content blocks.
      //
      // WHY ALL RESULTS IN ONE MESSAGE?
      // The Anthropic API requires that tool results for a given
      // assistant turn are sent together in the next user message.
      // Each tool_result must reference the tool_use_id from Claude's
      // response so Claude knows which result goes with which call.

      const toolUseBlocks = response.content.filter(
        (block): block is Anthropic.Messages.ToolUseBlock =>
          block.type === "tool_use"
      );

      if (toolUseBlocks.length === 0) {
        // Claude stopped for a reason other than end_turn or tool_use.
        // This can happen with max_tokens. Return whatever text we have.
        const textBlocks = response.content.filter(
          (block): block is Anthropic.Messages.TextBlock =>
            block.type === "text"
        );
        return textBlocks.map((b) => b.text).join("\n");
      }

      // Execute each tool and collect results
      const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];

      for (const toolUse of toolUseBlocks) {
        logAgentAction(
          this.info,
          `Executing tool: ${toolUse.name}(${JSON.stringify(toolUse.input).slice(0, 80)}...)`
        );

        try {
          // This calls the subclass's executeTool() — where the actual
          // agent-specific logic lives (creating tasks, sending messages, etc.)
          const result = await this.executeTool(
            toolUse.name,
            toolUse.input as Record<string, unknown>,
            taskId
          );

          toolResults.push({
            type: "tool_result" as const,
            tool_use_id: toolUse.id,
            content: result.result,
            is_error: result.isError,
          });
        } catch (err) {
          // If a tool throws, we don't crash the loop — we send the error
          // back to Claude as a tool_result with is_error: true. Claude
          // can then decide how to handle it (retry, use a different tool,
          // or give up gracefully).
          const errorMessage =
            err instanceof Error ? err.message : "Unknown error";
          logError(
            `Tool ${toolUse.name} failed for agent ${this.info.id}`,
            err
          );

          toolResults.push({
            type: "tool_result" as const,
            tool_use_id: toolUse.id,
            content: `Error: ${errorMessage}`,
            is_error: true,
          });
        }
      }

      // Add all tool results as the next user message.
      // This continues the conversation — Claude will see its tool calls
      // AND the results, then decide what to do next.
      history.push({
        role: "user" as const,
        content: toolResults,
      });

      // Loop back to step 1 — call Claude again with the updated history.
      // Claude now has the tool results and can decide to:
      // - Call more tools (the loop continues)
      // - Provide a final text response (the loop ends)
    }
  }

  // ===========================================================================
  // CONVERSATION HISTORY MANAGEMENT
  // ===========================================================================

  /**
   * Get the conversation history for a task, creating it if needed.
   */
  protected getHistory(taskId: string): Anthropic.MessageParam[] {
    if (!this.conversationHistories.has(taskId)) {
      this.conversationHistories.set(taskId, []);
    }
    return this.conversationHistories.get(taskId)!;
  }

  /**
   * Append a message to a task's conversation history.
   *
   * Used when external events need to be added to context — for example,
   * when a Researcher receives a clarification reply, the reply content
   * needs to be added to the conversation so Claude has the info on
   * its next turn.
   */
  protected appendToHistory(
    taskId: string,
    role: "user" | "assistant",
    content: string
  ): void {
    const history = this.getHistory(taskId);
    history.push({ role, content });
  }

  /**
   * Clear the conversation history for a task.
   * Used when a task is fully complete and we want to free memory.
   */
  protected clearHistory(taskId: string): void {
    this.conversationHistories.delete(taskId);
  }

  // ===========================================================================
  // MESSAGE SENDING HELPERS
  // ===========================================================================

  /**
   * Send a message through the bus. Convenience wrapper that fills in
   * the "from" field automatically.
   */
  protected sendMessage(
    type: MessageType,
    to: AgentInfo,
    taskId: string,
    payload: string
  ): void {
    this.bus.createAndSend({
      type,
      from: this.info,
      to,
      taskId,
      payload,
    });
  }
}
