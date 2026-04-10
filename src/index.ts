/**
 * index.ts — The orchestration layer
 *
 * This is the entry point that wires everything together. It:
 * 1. Creates the shared infrastructure (message bus, task manager)
 * 2. Spawns the agents (coordinator, researchers, synthesizer)
 * 3. Creates the root task and kicks off the process
 * 4. Waits for the session to complete (or time out)
 * 5. Prints the final report and session summary
 *
 * Think of this file as the "stage manager" — it sets up the stage,
 * introduces the actors, and signals the start of the show. Once the
 * show begins, the agents run autonomously. This file just watches
 * for the finale.
 *
 * USAGE:
 *   npx tsx src/index.ts "What are the business implications of quantum computing?"
 *
 * Or import and call runWorkforce() programmatically:
 *   import { runWorkforce } from "./index.js";
 *   const report = await runWorkforce("Your research question here");
 */

import { MessageBus } from "./message-bus.js";
import { TaskManager } from "./task-manager.js";
import { CoordinatorAgent } from "./agents/coordinator.js";
import { ResearcherAgent } from "./agents/researcher.js";
import { SynthesizerAgent } from "./agents/synthesizer.js";
import type { AgentInfo, WorkforceConfig } from "./types.js";
import { DEFAULT_CONFIG } from "./types.js";
import { logSystem, logError } from "./utils/logger.js";
import { resetApiCallCount, getApiCallCount } from "./utils/claude-client.js";

// =============================================================================
// THE MAIN ORCHESTRATION FUNCTION
// =============================================================================

/**
 * Run the entire workforce for a given research question.
 *
 * This function sets up the system, starts the research process,
 * and waits for completion. It returns the final report as a string.
 *
 * The flow:
 *
 *   1. Create infrastructure (bus + task manager)
 *   2. Create agent identities (AgentInfo objects)
 *   3. Instantiate agents (they subscribe to the bus automatically)
 *   4. Create the root task
 *   5. Send "task:assign" to the Coordinator → this starts everything
 *   6. Poll for session completion (or timeout)
 *   7. Return the report
 *
 * WHY POLLING INSTEAD OF EVENT-DRIVEN COMPLETION?
 * We could add a "session:complete" event to the message bus. But
 * polling is simpler to understand and debug. The poll interval
 * is 500ms, which is negligible compared to API call latency.
 * For a learning project, simplicity wins over elegance.
 *
 * @param question - The research question to investigate
 * @param config   - Optional configuration overrides
 * @returns The final report, or null if the session failed
 */
export async function runWorkforce(
  question: string,
  config?: Partial<WorkforceConfig>
): Promise<string | null> {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };

  // Reset the API call counter for this session
  resetApiCallCount();

  logSystem("=".repeat(60));
  logSystem("WORKFORCE SESSION STARTING");
  logSystem(`Question: "${question}"`);
  logSystem("=".repeat(60));

  // ---- Step 1: Create shared infrastructure ----

  const bus = new MessageBus();
  const taskManager = new TaskManager(question, mergedConfig);

  // ---- Step 2: Define agent identities ----
  //
  // AgentInfo is just an ID + role. The actual agent instances are
  // created next, but we need the identities first because agents
  // reference each other (coordinator needs researcher IDs, etc.)

  const coordinatorInfo: AgentInfo = { id: "coordinator-1", role: "coordinator" };
  const synthesizerInfo: AgentInfo = { id: "synthesizer-1", role: "synthesizer" };

  // Create 3 researchers. You can adjust this number — the Coordinator's
  // prompt will tell Claude how many researchers are available, and
  // Claude will create that many (or fewer) research tasks.
  const researcherInfos: AgentInfo[] = [
    { id: "researcher-1", role: "researcher" },
    { id: "researcher-2", role: "researcher" },
    { id: "researcher-3", role: "researcher" },
  ];

  // ---- Step 3: Instantiate agents ----
  //
  // Each constructor subscribes the agent to the message bus
  // and registers it with the task manager. After this step,
  // every agent is listening for messages.

  // We hold references to the agents so they don't get garbage collected.
  // The agents themselves are event-driven (they react to messages),
  // so we don't call methods on them directly after construction.

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const coordinator = new CoordinatorAgent(
    coordinatorInfo,
    bus,
    taskManager,
    question,
    researcherInfos,
    synthesizerInfo
  );

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const researchers = researcherInfos.map(
    (info) => new ResearcherAgent(info, bus, taskManager, coordinatorInfo)
  );

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const synthesizer = new SynthesizerAgent(
    synthesizerInfo,
    bus,
    taskManager,
    coordinatorInfo
  );

  // ---- Step 4: Create the root task ----
  //
  // The root task represents the entire research question.
  // It's assigned to the Coordinator, who will decompose it.

  const rootTask = taskManager.createTask({
    parentTaskId: null, // This IS the root
    assignedTo: coordinatorInfo,
    createdBy: coordinatorInfo, // The coordinator "creates" its own root task
    description: `Research: ${question}`,
    input: question,
  });

  // ---- Step 5: Kick it off! ----
  //
  // Send the root task to the Coordinator. This single message
  // triggers the entire cascade:
  //   Coordinator decomposes → Researchers investigate →
  //   Coordinator evaluates → Synthesizer produces report

  logSystem("Sending root task to Coordinator...");

  bus.createAndSend({
    type: "task:assign",
    from: coordinatorInfo,
    to: coordinatorInfo,
    taskId: rootTask.id,
    payload: question,
  });

  // ---- Step 6: Wait for completion ----
  //
  // The agents are now running autonomously. We poll the session
  // status until it's done or we hit the timeout.
  //
  // WHY NOT JUST AWAIT THE COORDINATOR?
  // Because the process involves multiple async message exchanges
  // between agents. There's no single promise to await. The session
  // status in the TaskManager is the source of truth for "are we done?"

  const report = await waitForCompletion(taskManager, mergedConfig);

  // ---- Step 7: Print results ----

  logSystem("=".repeat(60));

  if (report) {
    logSystem("WORKFORCE SESSION COMPLETED SUCCESSFULLY");
    logSystem("=".repeat(60));
    console.log("\n" + report + "\n");
  } else {
    logSystem("WORKFORCE SESSION FAILED");
    logSystem("=".repeat(60));
  }

  // Print the task summary for debugging
  taskManager.printTaskSummary();
  logSystem(`Total API calls: ${getApiCallCount()}`);

  // Clean up
  bus.reset();

  return report;
}

// =============================================================================
// COMPLETION WAITING
// =============================================================================

/**
 * Wait for the workforce session to complete, with timeout.
 *
 * This polls the task manager's session status every 500ms.
 * The session completes when:
 * - The Synthesizer submits a report (via the Coordinator completing the session)
 * - OR the timeout is reached
 * - OR a fatal error occurs
 *
 * HOWEVER — there's a subtlety. The agents communicate through the
 * message bus, and message handlers are async. We need to detect
 * when all agents are IDLE (no pending messages, no in-flight API calls)
 * and the session has a final report.
 *
 * Our approach: look for a completed synthesis task. When the Synthesizer
 * submits a report, it marks its task as "completed" with the report
 * as the result. We check for this.
 */
async function waitForCompletion(
  taskManager: TaskManager,
  config: WorkforceConfig
): Promise<string | null> {
  const startTime = Date.now();

  while (true) {
    // Check timeout
    const elapsed = Date.now() - startTime;
    if (elapsed > config.sessionTimeoutMs) {
      logError(
        `Session timed out after ${(elapsed / 1000).toFixed(0)}s ` +
          `(limit: ${(config.sessionTimeoutMs / 1000).toFixed(0)}s)`
      );
      taskManager.failSession("Timeout");
      return null;
    }

    // Check for a completed synthesis task.
    // The synthesis task has "Synthesize" in its description and
    // contains the final report in its result.
    const allTasks = taskManager.getAllTasks();
    const synthesisTask = allTasks.find(
      (t) =>
        t.description.includes("Synthesize") && t.status === "completed"
    );

    if (synthesisTask?.result) {
      taskManager.completeSession(synthesisTask.result);
      return synthesisTask.result;
    }

    // Check if the session was marked as failed by an agent
    const session = taskManager.getSession();
    if (session.status === "failed") {
      return null;
    }

    // Wait 500ms before checking again
    await sleep(500);
  }
}

/**
 * Simple sleep utility.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// =============================================================================
// CLI ENTRY POINT
// =============================================================================

/**
 * If this file is run directly (not imported), read the research
 * question from command-line arguments and run the workforce.
 *
 * Usage:
 *   npx tsx src/index.ts "Your research question here"
 */
const isMainModule = process.argv[1]?.endsWith("index.ts") ||
  process.argv[1]?.endsWith("index.js");

if (isMainModule) {
  const question = process.argv[2];

  if (!question) {
    console.log("Usage: npx tsx src/index.ts \"Your research question here\"");
    console.log(
      '\nExample: npx tsx src/index.ts "What are the business implications of quantum computing in the next 5 years?"'
    );
    process.exit(1);
  }

  runWorkforce(question)
    .then((report) => {
      process.exit(report ? 0 : 1);
    })
    .catch((err) => {
      logError("Fatal error", err);
      process.exit(1);
    });
}
