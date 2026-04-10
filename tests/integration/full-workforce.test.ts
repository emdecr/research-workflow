/**
 * full-workforce.test.ts — Integration test for the full agent workflow
 *
 * This test runs the complete workforce pipeline with a mock Claude client.
 * No real API calls are made — we control exactly what "Claude" responds
 * at each step.
 *
 * THE TEST SCENARIO:
 *
 * 1. Coordinator receives the question and creates 2 research tasks
 * 2. Both Researchers submit their findings
 * 3. Coordinator accepts both findings
 * 4. Coordinator sends findings to Synthesizer
 * 5. Synthesizer produces the final report
 *
 * This exercises the full message flow:
 *   task:assign → tool calls → task:complete → evaluation → synthesis
 *
 * HOW MOCKING WORKS HERE:
 *
 * We can't easily replace the Anthropic client inside the agents because
 * it's imported at module level in claude-client.ts. Instead, we use
 * vitest's module mocking (vi.mock) to replace the entire module.
 * The mock client returns canned responses that simulate Claude's behavior.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  mockToolUseResponse,
  mockMultiToolResponse,
  mockTextResponse,
} from "./mock-claude-client.js";

// ---------------------------------------------------------------------------
// Set up the mock BEFORE importing any modules that use the client.
//
// vi.mock is HOISTED to the top of the file by vitest. This means the
// factory function runs before any imports in this file. We can't
// reference imported variables inside vi.mock — they don't exist yet.
//
// Solution: build a minimal mock client inline inside vi.hoisted().
// This gives us a mock object that exists in the hoisted scope and
// can be referenced by both the vi.mock factory and our test code.
// ---------------------------------------------------------------------------

const { mockMessages, apiCallState } = vi.hoisted(() => {
  // Inline mock — we can't import MockClaudeClient here because
  // vi.hoisted runs before imports. So we build a minimal version
  // with just what the agents need: a messages.create() method.
  type Handler = (params: any) => any;
  let handler: Handler | null = null;
  const calls: any[] = [];

  return {
    mockMessages: {
      setHandler(h: Handler) { handler = h; },
      getCalls() { return calls; },
      reset() { handler = null; calls.length = 0; },
      // This is the object that gets used as `client` in agents.
      // Agents call `client.messages.create(params)`.
      asClient: {
        messages: {
          create: async (params: any) => {
            calls.push(params);
            if (handler) return handler(params);
            throw new Error("No mock handler set");
          },
        },
      },
    },
    apiCallState: { count: 0 },
  };
});

vi.mock("../../src/utils/claude-client.js", () => ({
  client: mockMessages.asClient,
  incrementApiCallCount: () => ++apiCallState.count,
  getApiCallCount: () => apiCallState.count,
  resetApiCallCount: () => { apiCallState.count = 0; },
}));

// NOW we can import the modules that use the client
import { MessageBus } from "../../src/message-bus.js";
import { TaskManager } from "../../src/task-manager.js";
import { CoordinatorAgent } from "../../src/agents/coordinator.js";
import { ResearcherAgent } from "../../src/agents/researcher.js";
import { SynthesizerAgent } from "../../src/agents/synthesizer.js";
import type { AgentInfo } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe("Full Workforce Integration", () => {
  let bus: MessageBus;
  let taskManager: TaskManager;

  // Agent identities
  const coordinatorInfo: AgentInfo = { id: "coordinator-1", role: "coordinator" };
  const researcher1Info: AgentInfo = { id: "researcher-1", role: "researcher" };
  const researcher2Info: AgentInfo = { id: "researcher-2", role: "researcher" };
  const synthesizerInfo: AgentInfo = { id: "synthesizer-1", role: "synthesizer" };

  beforeEach(() => {
    mockMessages.reset();
    apiCallState.count = 0;
    bus = new MessageBus();
    taskManager = new TaskManager("What is the impact of AI on healthcare?");
  });

  it("completes a full research session with 2 researchers", async () => {
    /**
     * Set up a dynamic handler that returns different responses
     * based on what the agents are asking.
     *
     * This simulates Claude's behavior at each step of the workflow.
     * We inspect the system prompt and messages to determine which
     * agent is calling and what they need.
     */
    mockMessages.setHandler((params: any) => {
      const systemPrompt = typeof params.system === "string" ? params.system : "";
      const lastMessage = params.messages[params.messages.length - 1];
      const lastContent = typeof lastMessage.content === "string"
        ? lastMessage.content
        : "";

      // ---- COORDINATOR: Decompose into research tasks ----
      if (
        systemPrompt.includes("Coordinator") &&
        lastContent.includes("create research tasks")
      ) {
        return mockMultiToolResponse(
          [
            {
              name: "create_research_task",
              input: {
                angle: "AI in medical diagnostics",
                guiding_questions: [
                  "How is AI currently used in diagnostics?",
                  "What are the accuracy rates?",
                ],
              },
            },
            {
              name: "create_research_task",
              input: {
                angle: "AI in drug discovery",
                guiding_questions: [
                  "How does AI accelerate drug development?",
                  "What are recent breakthroughs?",
                ],
              },
            },
          ],
          "I'll break this into two research angles."
        );
      }

      // ---- COORDINATOR: After creating tasks, finish turn ----
      if (
        systemPrompt.includes("Coordinator") &&
        lastContent.includes("Research task created")
      ) {
        return mockTextResponse(
          "I've created 2 research tasks covering diagnostics and drug discovery."
        );
      }

      // ---- RESEARCHER: Submit findings ----
      if (
        systemPrompt.includes("Research Agent") &&
        lastContent.includes("submit your findings")
      ) {
        const angle = lastContent.includes("diagnostics")
          ? "diagnostics"
          : "drug discovery";

        return mockToolUseResponse("submit_finding", {
          findings:
            `## Key Points\n- AI ${angle} is rapidly advancing\n` +
            `## Analysis\nDetailed analysis of ${angle}.\n` +
            `## Uncertainties\nLimited long-term data available.`,
        });
      }

      // ---- RESEARCHER: After submitting, finish turn ----
      if (
        systemPrompt.includes("Research Agent") &&
        lastContent.includes("submitted successfully")
      ) {
        return mockTextResponse("Findings submitted.");
      }

      // ---- COORDINATOR: Evaluate findings (accept them) ----
      if (
        systemPrompt.includes("Coordinator") &&
        lastContent.includes("evaluate these findings")
      ) {
        // Extract the task ID from the message
        const taskIdMatch = lastContent.match(/task ID is: ([a-f0-9-]+)/);
        const taskId = taskIdMatch ? taskIdMatch[1] : "unknown";

        return mockToolUseResponse("evaluate_finding", {
          task_id: taskId,
          acceptable: true,
          feedback: "Good coverage of the topic.",
        });
      }

      // ---- COORDINATOR: After evaluation, finish turn ----
      if (
        systemPrompt.includes("Coordinator") &&
        lastContent.includes("Finding accepted")
      ) {
        return mockTextResponse("Finding accepted.");
      }

      // ---- COORDINATOR: Request synthesis ----
      if (
        systemPrompt.includes("Coordinator") &&
        lastContent.includes("request_synthesis tool")
      ) {
        return mockToolUseResponse("request_synthesis", {
          summary_of_findings:
            "Two angles researched: AI in diagnostics and drug discovery. Both completed successfully.",
        });
      }

      // ---- COORDINATOR: After requesting synthesis ----
      if (
        systemPrompt.includes("Coordinator") &&
        lastContent.includes("Synthesis task created")
      ) {
        return mockTextResponse("Synthesis has been requested.");
      }

      // ---- SYNTHESIZER: Produce report ----
      if (
        systemPrompt.includes("Synthesizer") &&
        lastContent.includes("synthesize the following")
      ) {
        return mockToolUseResponse("submit_report", {
          report:
            "# AI in Healthcare: Research Report\n\n" +
            "## Executive Summary\n" +
            "AI is transforming healthcare through diagnostics and drug discovery.\n\n" +
            "## Key Findings\n" +
            "- AI diagnostics is rapidly advancing with improving accuracy\n" +
            "- Drug discovery timelines are being compressed\n\n" +
            "## Conclusion\n" +
            "Significant potential with need for careful validation.",
        });
      }

      // ---- SYNTHESIZER: After submitting report ----
      if (
        systemPrompt.includes("Synthesizer") &&
        lastContent.includes("submitted successfully")
      ) {
        return mockTextResponse("Report complete.");
      }

      // ---- Fallback ----
      // If we hit this, the test setup is missing a handler.
      // Return a text response so the loop ends cleanly.
      console.warn(
        "MOCK FALLBACK — unhandled call. System prompt starts with:",
        systemPrompt.slice(0, 50),
        "Last message starts with:",
        lastContent.slice(0, 80)
      );
      return mockTextResponse("(mock fallback — no matching handler)");
    });

    // ---- Create agents ----

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const coordinator = new CoordinatorAgent(
      coordinatorInfo,
      bus,
      taskManager,
      "What is the impact of AI on healthcare?",
      [researcher1Info, researcher2Info],
      synthesizerInfo
    );

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const researcher1 = new ResearcherAgent(
      researcher1Info,
      bus,
      taskManager,
      coordinatorInfo
    );

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const researcher2 = new ResearcherAgent(
      researcher2Info,
      bus,
      taskManager,
      coordinatorInfo
    );

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const synthesizer = new SynthesizerAgent(
      synthesizerInfo,
      bus,
      taskManager,
      coordinatorInfo
    );

    // ---- Create root task and kick off ----

    const rootTask = taskManager.createTask({
      parentTaskId: null,
      assignedTo: coordinatorInfo,
      createdBy: coordinatorInfo,
      description: "Research: AI in healthcare",
      input: "What is the impact of AI on healthcare?",
    });

    bus.createAndSend({
      type: "task:assign",
      from: coordinatorInfo,
      to: coordinatorInfo,
      taskId: rootTask.id,
      payload: "What is the impact of AI on healthcare?",
    });

    // ---- Wait for completion ----
    // Give the async message handlers time to run.
    // In a real scenario, we'd use the polling from index.ts.
    // Here we just wait a reasonable amount for all promises to settle.

    await waitForCondition(
      () => {
        const tasks = taskManager.getAllTasks();
        return tasks.some(
          (t) => t.description.includes("Synthesize") && t.status === "completed"
        );
      },
      5000,
      "synthesis task to complete"
    );

    // ---- Assertions ----

    // Check that the synthesis task completed with a report
    const allTasks = taskManager.getAllTasks();
    const synthesisTask = allTasks.find(
      (t) => t.description.includes("Synthesize") && t.status === "completed"
    );

    expect(synthesisTask).toBeDefined();
    expect(synthesisTask!.result).toContain("AI in Healthcare");
    expect(synthesisTask!.result).toContain("Executive Summary");

    // Check that research tasks were created and completed
    const researchTasks = allTasks.filter((t) =>
      t.description.includes("Research angle")
    );
    expect(researchTasks).toHaveLength(2);
    expect(researchTasks.every((t) => t.status === "completed")).toBe(true);

    // Check message flow
    const log = bus.getMessageLog();
    const messageTypes = log.map((m) => m.type);

    // Should have task:assign messages (root + 2 research + 1 synthesis)
    expect(messageTypes.filter((t) => t === "task:assign").length).toBeGreaterThanOrEqual(3);

    // Should have task:complete messages (2 research + 1 synthesis)
    expect(messageTypes.filter((t) => t === "task:complete").length).toBeGreaterThanOrEqual(2);

    // Check API calls were tracked
    expect(apiCallState.count).toBeGreaterThan(0);

    // Print summary for debugging
    taskManager.printTaskSummary();
  });
});

// ---------------------------------------------------------------------------
// Test utilities
// ---------------------------------------------------------------------------

/**
 * Wait for a condition to become true, with timeout.
 * Polls every 50ms. Throws if the condition isn't met before timeout.
 */
async function waitForCondition(
  condition: () => boolean,
  timeoutMs: number,
  description: string
): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
