/**
 * mock-claude-client.ts — A fake Claude API client for testing
 *
 * When testing agent systems, you face a dilemma:
 * - Real API calls are slow (~2-5 seconds each) and cost money
 * - But agents are DEFINED by their Claude interactions
 *
 * The solution: a mock client that returns predictable responses.
 * This lets you test the full agent flow — message passing, task
 * management, tool execution — without hitting the API.
 *
 * HOW IT WORKS:
 *
 * You register "response handlers" — functions that look at the
 * incoming messages and return a canned Claude response. The mock
 * replaces the real Anthropic client, so agents call it exactly
 * the same way they'd call the real API.
 *
 * The handlers are what make this useful: you can simulate:
 * - A Coordinator that creates exactly 2 research tasks
 * - A Researcher that submits findings immediately
 * - A Synthesizer that produces a report
 * - A Coordinator that rejects a finding (testing the retry loop)
 *
 * Each handler returns an Anthropic.Messages.Message-shaped object
 * with the right content blocks (text blocks, tool_use blocks, etc.)
 */

import Anthropic from "@anthropic-ai/sdk";

// =============================================================================
// TYPES
// =============================================================================

/**
 * A handler function that receives the messages sent to "Claude"
 * and returns a mock response.
 *
 * The handler gets the full create() params so it can inspect
 * the system prompt, messages, and tools to decide what to return.
 */
export type MockResponseHandler = (
  params: Anthropic.Messages.MessageCreateParams
) => Anthropic.Messages.Message;

// =============================================================================
// RESPONSE BUILDERS — Helpers to create properly-shaped responses
// =============================================================================

/**
 * Create a mock response where Claude returns text (no tool calls).
 * This simulates Claude responding with a final answer.
 */
export function mockTextResponse(text: string): Anthropic.Messages.Message {
  return {
    id: `mock-${Date.now()}`,
    type: "message",
    role: "assistant",
    model: "mock-model",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  };
}

/**
 * Create a mock response where Claude calls a tool.
 * This simulates Claude deciding to take an action.
 *
 * After returning this, the tool-use loop will:
 * 1. Execute the tool (via the agent's executeTool method)
 * 2. Send the result back as a tool_result message
 * 3. Call the mock client again for the next response
 *
 * @param toolName - The tool Claude wants to call
 * @param toolInput - The arguments for the tool
 * @param toolUseId - A unique ID for this tool use (defaults to auto-generated)
 * @param prefixText - Optional text Claude says before the tool call
 */
export function mockToolUseResponse(
  toolName: string,
  toolInput: Record<string, unknown>,
  toolUseId?: string,
  prefixText?: string
): Anthropic.Messages.Message {
  const content: Anthropic.Messages.ContentBlock[] = [];

  // Claude often explains what it's doing before calling a tool
  if (prefixText) {
    content.push({ type: "text", text: prefixText });
  }

  content.push({
    type: "tool_use",
    id: toolUseId ?? `tool-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name: toolName,
    input: toolInput,
  });

  return {
    id: `mock-${Date.now()}`,
    type: "message",
    role: "assistant",
    model: "mock-model",
    content,
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  };
}

/**
 * Create a mock response with multiple tool calls in one turn.
 * This simulates Claude calling several tools at once (e.g., the
 * Coordinator creating multiple research tasks simultaneously).
 */
export function mockMultiToolResponse(
  tools: Array<{ name: string; input: Record<string, unknown> }>,
  prefixText?: string
): Anthropic.Messages.Message {
  const content: Anthropic.Messages.ContentBlock[] = [];

  if (prefixText) {
    content.push({ type: "text", text: prefixText });
  }

  for (const tool of tools) {
    content.push({
      type: "tool_use",
      id: `tool-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name: tool.name,
      input: tool.input,
    });
  }

  return {
    id: `mock-${Date.now()}`,
    type: "message",
    role: "assistant",
    model: "mock-model",
    content,
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  };
}

// =============================================================================
// THE MOCK CLIENT
// =============================================================================

/**
 * A mock Anthropic client that uses registered handlers to
 * produce responses instead of calling the real API.
 *
 * Usage in tests:
 *
 *   const mock = new MockClaudeClient();
 *
 *   // First call returns a tool use, second returns text
 *   mock.addResponse(mockToolUseResponse("submit_finding", { findings: "..." }));
 *   mock.addResponse(mockTextResponse("Done!"));
 *
 *   // Inject into the module system (see integration tests for how)
 */
export class MockClaudeClient {
  /**
   * Queue of responses to return, in order.
   * Each call to messages.create() pops the next response.
   */
  private responseQueue: Anthropic.Messages.Message[] = [];

  /**
   * Optional dynamic handler. If set, it's called instead of the queue.
   * Useful when you need response logic that depends on the input.
   */
  private dynamicHandler: MockResponseHandler | null = null;

  /**
   * Record of all calls made, for assertions in tests.
   */
  readonly calls: Anthropic.Messages.MessageCreateParams[] = [];

  /**
   * Add a canned response to the queue.
   * Responses are returned in FIFO order.
   */
  addResponse(response: Anthropic.Messages.Message): void {
    this.responseQueue.push(response);
  }

  /**
   * Set a dynamic handler that generates responses based on input.
   * When set, this takes priority over the response queue.
   */
  setHandler(handler: MockResponseHandler): void {
    this.dynamicHandler = handler;
  }

  /**
   * The mock messages API. This is what agents actually call.
   * It matches the shape of `client.messages.create()` from
   * the Anthropic SDK.
   */
  get messages() {
    // We need to return an object with a create() method.
    // Using an arrow function to preserve `this` context.
    return {
      create: async (
        params: Anthropic.Messages.MessageCreateParams
      ): Promise<Anthropic.Messages.Message> => {
        // Record the call for test assertions
        this.calls.push(params);

        // Use dynamic handler if set
        if (this.dynamicHandler) {
          return this.dynamicHandler(params);
        }

        // Otherwise, pop from the queue
        const response = this.responseQueue.shift();
        if (!response) {
          throw new Error(
            `MockClaudeClient: no more responses in queue. ` +
              `${this.calls.length} calls made so far. ` +
              `Add more responses with addResponse() or use setHandler().`
          );
        }

        return response;
      },
    };
  }

  /**
   * Reset the mock — clear queue, handler, and call history.
   */
  reset(): void {
    this.responseQueue = [];
    this.dynamicHandler = null;
    this.calls.length = 0;
  }
}
