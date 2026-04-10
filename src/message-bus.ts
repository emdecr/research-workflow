/**
 * message-bus.ts — How agents communicate with each other
 *
 * In a multi-agent system, agents need a way to talk. There are three
 * common approaches:
 *
 * 1. DIRECT CALLS — Agent A has a reference to Agent B and calls its methods.
 *    Simple, but tightly couples agents together. If you add a new agent type,
 *    you have to update every agent that talks to it. Also, no audit trail.
 *
 * 2. SHARED STATE — All agents read/write to a shared data structure (a
 *    "blackboard"). Flexible, but hard to reason about — any agent can
 *    change anything at any time, and you can't tell who changed what.
 *
 * 3. MESSAGE BUS — Agents send messages to a central bus, which routes them
 *    to the right recipient. This is what we use. Why?
 *    - Agents are decoupled: the Coordinator doesn't need a reference to
 *      a Researcher instance, just its ID
 *    - Every message is logged automatically (the audit trail)
 *    - Adding new agent types doesn't require changing existing agents
 *    - It matches the mental model of people talking to each other
 *
 * Our message bus is built on Node's EventEmitter. In production, you might
 * use Redis pub/sub or a real message queue. But EventEmitter is perfect
 * for learning: it's synchronous dispatch (easy to debug), in-process
 * (no infrastructure), and you can see exactly what happens in what order.
 *
 * HOW IT WORKS:
 *
 *   1. Each agent subscribes to messages addressed to its ID:
 *        bus.subscribe("researcher-2", handler)
 *
 *   2. When any agent sends a message, the bus routes it by the "to" field:
 *        bus.send({ from: coordinator, to: researcher2, type: "task:assign", ... })
 *
 *   3. The handler fires with the message. The agent decides what to do.
 *
 *   4. Every message is recorded in the audit log for debugging and analysis.
 */

import { EventEmitter } from "events";
import { v4 as uuidv4 } from "uuid";
import type { AgentInfo, AgentMessage, MessageType } from "./types.js";
import { logMessage, logSystem } from "./utils/logger.js";

/**
 * MessageBus — the central communication channel for the workforce.
 *
 * It extends EventEmitter, which gives us the publish/subscribe pattern
 * for free. We just add:
 * - Typed message creation (via the send() helper)
 * - An audit log (every message ever sent)
 * - A waitForMessage() utility for request/response patterns
 */
export class MessageBus extends EventEmitter {
  /**
   * The complete history of every message sent through this bus.
   * This is the "flight recorder" of the workforce — invaluable for
   * debugging why agents made the decisions they did.
   *
   * In a production system, you'd write this to a database or log service.
   * Here, we keep it in memory for simplicity.
   */
  private messageLog: AgentMessage[] = [];

  constructor() {
    super();
    // By default, EventEmitter warns if more than 10 listeners are added
    // to a single event. With multiple agents, we'll exceed that easily.
    // A workforce of 5 agents (1 coordinator + 3 researchers + 1 synthesizer)
    // means 5 listeners minimum.
    this.setMaxListeners(20);
  }

  // ===========================================================================
  // SENDING MESSAGES
  // ===========================================================================

  /**
   * Send a message from one agent to another.
   *
   * This is the primary way agents communicate. The message is:
   * 1. Stamped with a unique ID and timestamp
   * 2. Recorded in the audit log
   * 3. Logged to the console (via the logger)
   * 4. Dispatched to the recipient's handler
   *
   * The dispatch is SYNCHRONOUS — the handler runs immediately within
   * this call. This makes the flow easier to follow in logs, but it
   * means a slow handler blocks the sender. In our system this is fine
   * because agent handlers are async (they kick off work and return).
   */
  send(message: AgentMessage): void {
    // Record in the audit log
    this.messageLog.push(message);

    // Log to console so you can follow the conversation
    logMessage(message);

    // Route to the recipient by emitting on their specific channel.
    // The event name is "agent:<id>" — this ensures each agent only
    // receives messages addressed to it, not all messages on the bus.
    this.emit(`agent:${message.to.id}`, message);
  }

  /**
   * Convenience method to create and send a message in one call.
   * Handles ID generation and timestamping so callers don't have to.
   *
   * Usage:
   *   bus.createAndSend({
   *     type: "task:assign",
   *     from: coordinatorInfo,
   *     to: researcherInfo,
   *     taskId: "task-123",
   *     payload: "Research the economic impact of quantum computing"
   *   });
   */
  createAndSend(
    params: Omit<AgentMessage, "id" | "timestamp">
  ): AgentMessage {
    const message: AgentMessage = {
      ...params,
      id: uuidv4(),
      timestamp: new Date(),
    };
    this.send(message);
    return message;
  }

  // ===========================================================================
  // RECEIVING MESSAGES
  // ===========================================================================

  /**
   * Subscribe an agent to receive messages addressed to it.
   *
   * The handler is called every time a message is sent to this agent's ID.
   * An agent typically subscribes once during initialization and handles
   * all incoming messages in a single handler that switches on message type.
   *
   * Example:
   *   bus.subscribe("researcher-2", (msg) => {
   *     switch (msg.type) {
   *       case "task:assign": // start working
   *       case "task:reject": // retry with feedback
   *       case "clarification:reply": // continue with new info
   *     }
   *   });
   */
  subscribe(
    agentId: string,
    handler: (message: AgentMessage) => void
  ): void {
    this.on(`agent:${agentId}`, handler);
    logSystem(`Agent ${agentId} subscribed to message bus`);
  }

  /**
   * Unsubscribe an agent from the bus.
   * Used during cleanup when a session ends.
   */
  unsubscribe(agentId: string): void {
    this.removeAllListeners(`agent:${agentId}`);
  }

  // ===========================================================================
  // WAITING FOR SPECIFIC MESSAGES
  // ===========================================================================

  /**
   * Wait for a specific type of message to arrive for a given agent.
   * Returns a Promise that resolves with the message.
   *
   * This is essential for REQUEST/RESPONSE patterns. For example, when
   * a Researcher asks for clarification, it needs to pause and wait
   * for the reply before continuing:
   *
   *   // Researcher sends a question
   *   bus.createAndSend({ type: "clarification:ask", ... });
   *
   *   // Then waits for the answer
   *   const reply = await bus.waitForMessage(
   *     "researcher-2",
   *     "clarification:reply",
   *     "task-456"
   *   );
   *
   * The taskId filter ensures we get the reply for the RIGHT task,
   * not some unrelated clarification reply.
   *
   * The timeout prevents hanging forever if the reply never comes
   * (e.g., the Coordinator crashed or the session timed out).
   */
  waitForMessage(
    agentId: string,
    messageType: MessageType,
    taskId: string,
    timeoutMs: number = 60_000
  ): Promise<AgentMessage> {
    return new Promise((resolve, reject) => {
      const eventName = `agent:${agentId}`;

      // Set up a timeout so we don't wait forever
      const timer = setTimeout(() => {
        this.removeListener(eventName, handler);
        reject(
          new Error(
            `Timeout waiting for ${messageType} message for agent ${agentId} on task ${taskId}`
          )
        );
      }, timeoutMs);

      // Listen for the specific message we want
      const handler = (message: AgentMessage) => {
        // Filter: must match both the message type AND the task
        if (message.type === messageType && message.taskId === taskId) {
          clearTimeout(timer);
          this.removeListener(eventName, handler);
          resolve(message);
        }
        // If it doesn't match, we ignore it — the agent's main handler
        // will process it. We just keep waiting for our specific message.
      };

      this.on(eventName, handler);
    });
  }

  // ===========================================================================
  // AUDIT LOG
  // ===========================================================================

  /**
   * Get the complete message history.
   * Returns a copy so callers can't accidentally mutate the log.
   *
   * Use this after a session completes to analyze what happened:
   * - How many messages were sent?
   * - How many rejections/retries occurred?
   * - What was the conversation flow between agents?
   */
  getMessageLog(): AgentMessage[] {
    return [...this.messageLog];
  }

  /**
   * Get messages filtered by type.
   * Useful for analysis: "show me all rejections" or "show me all task completions."
   */
  getMessagesByType(type: MessageType): AgentMessage[] {
    return this.messageLog.filter((msg) => msg.type === type);
  }

  /**
   * Get all messages related to a specific task.
   * Shows the full conversation around a single unit of work.
   */
  getMessagesForTask(taskId: string): AgentMessage[] {
    return this.messageLog.filter((msg) => msg.taskId === taskId);
  }

  /**
   * Reset the bus — clears all listeners and the audit log.
   * Used between test runs or when starting a new session.
   */
  reset(): void {
    this.removeAllListeners();
    this.messageLog = [];
  }
}
