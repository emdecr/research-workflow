/**
 * message-bus.test.ts — Tests for the MessageBus
 *
 * These tests verify the core communication layer:
 * - Messages are routed to the correct agent
 * - The audit log records everything
 * - Filtering works (by type, by task)
 * - waitForMessage resolves/rejects correctly
 */

import { describe, it, expect, beforeEach } from "vitest";
import { MessageBus } from "../../src/message-bus.js";
import type { AgentInfo, AgentMessage } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Test fixtures — reusable agent identities and message builders
// ---------------------------------------------------------------------------

const coordinator: AgentInfo = { id: "coordinator-1", role: "coordinator" };
const researcher: AgentInfo = { id: "researcher-1", role: "researcher" };
const synthesizer: AgentInfo = { id: "synthesizer-1", role: "synthesizer" };

function makeMessage(
  overrides: Partial<AgentMessage> = {}
): AgentMessage {
  return {
    id: "msg-1",
    type: "task:assign",
    from: coordinator,
    to: researcher,
    taskId: "task-1",
    payload: "Test payload",
    timestamp: new Date(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MessageBus", () => {
  let bus: MessageBus;

  beforeEach(() => {
    bus = new MessageBus();
  });

  // ---- Routing ----

  describe("message routing", () => {
    it("delivers a message to the correct subscriber", () => {
      const received: AgentMessage[] = [];
      bus.subscribe(researcher.id, (msg) => received.push(msg));

      const message = makeMessage();
      bus.send(message);

      expect(received).toHaveLength(1);
      expect(received[0].payload).toBe("Test payload");
    });

    it("does NOT deliver to a different agent", () => {
      const received: AgentMessage[] = [];
      bus.subscribe(synthesizer.id, (msg) => received.push(msg));

      // Message is addressed to researcher, not synthesizer
      bus.send(makeMessage({ to: researcher }));

      expect(received).toHaveLength(0);
    });

    it("delivers to multiple subscribers on different channels", () => {
      const researcherMsgs: AgentMessage[] = [];
      const synthesizerMsgs: AgentMessage[] = [];

      bus.subscribe(researcher.id, (msg) => researcherMsgs.push(msg));
      bus.subscribe(synthesizer.id, (msg) => synthesizerMsgs.push(msg));

      bus.send(makeMessage({ to: researcher }));
      bus.send(makeMessage({ id: "msg-2", to: synthesizer }));

      expect(researcherMsgs).toHaveLength(1);
      expect(synthesizerMsgs).toHaveLength(1);
    });
  });

  // ---- createAndSend ----

  describe("createAndSend", () => {
    it("auto-generates id and timestamp", () => {
      const received: AgentMessage[] = [];
      bus.subscribe(researcher.id, (msg) => received.push(msg));

      const message = bus.createAndSend({
        type: "task:assign",
        from: coordinator,
        to: researcher,
        taskId: "task-1",
        payload: "Auto-generated fields test",
      });

      expect(message.id).toBeDefined();
      expect(message.timestamp).toBeInstanceOf(Date);
      expect(received).toHaveLength(1);
    });
  });

  // ---- Audit log ----

  describe("audit log", () => {
    it("records all sent messages", () => {
      bus.send(makeMessage({ id: "msg-1" }));
      bus.send(makeMessage({ id: "msg-2" }));
      bus.send(makeMessage({ id: "msg-3" }));

      const log = bus.getMessageLog();
      expect(log).toHaveLength(3);
    });

    it("returns a copy so the log cannot be mutated externally", () => {
      bus.send(makeMessage());
      const log = bus.getMessageLog();
      log.pop(); // Mutate the copy

      expect(bus.getMessageLog()).toHaveLength(1); // Original unchanged
    });

    it("filters messages by type", () => {
      bus.send(makeMessage({ id: "msg-1", type: "task:assign" }));
      bus.send(makeMessage({ id: "msg-2", type: "task:complete" }));
      bus.send(makeMessage({ id: "msg-3", type: "task:assign" }));

      const assigns = bus.getMessagesByType("task:assign");
      expect(assigns).toHaveLength(2);
    });

    it("filters messages by task ID", () => {
      bus.send(makeMessage({ id: "msg-1", taskId: "task-A" }));
      bus.send(makeMessage({ id: "msg-2", taskId: "task-B" }));
      bus.send(makeMessage({ id: "msg-3", taskId: "task-A" }));

      const taskAMsgs = bus.getMessagesForTask("task-A");
      expect(taskAMsgs).toHaveLength(2);
    });
  });

  // ---- waitForMessage ----

  describe("waitForMessage", () => {
    it("resolves when the matching message arrives", async () => {
      // Start waiting BEFORE the message is sent
      const waitPromise = bus.waitForMessage(
        researcher.id,
        "clarification:reply",
        "task-1"
      );

      // Send the matching message after a short delay
      setTimeout(() => {
        bus.send(
          makeMessage({
            type: "clarification:reply",
            from: coordinator,
            to: researcher,
            taskId: "task-1",
            payload: "Here is your clarification",
          })
        );
      }, 10);

      const result = await waitPromise;
      expect(result.payload).toBe("Here is your clarification");
    });

    it("ignores messages with wrong type", async () => {
      const waitPromise = bus.waitForMessage(
        researcher.id,
        "clarification:reply",
        "task-1",
        500 // short timeout for this test
      );

      // Send a message with the wrong type
      setTimeout(() => {
        bus.send(
          makeMessage({
            type: "task:assign", // wrong type
            to: researcher,
            taskId: "task-1",
          })
        );
      }, 10);

      // Should timeout because the right message never arrives
      await expect(waitPromise).rejects.toThrow("Timeout");
    });

    it("ignores messages for a different task", async () => {
      const waitPromise = bus.waitForMessage(
        researcher.id,
        "clarification:reply",
        "task-1",
        500
      );

      // Send a message for a different task
      setTimeout(() => {
        bus.send(
          makeMessage({
            type: "clarification:reply",
            to: researcher,
            taskId: "task-DIFFERENT", // wrong task
          })
        );
      }, 10);

      await expect(waitPromise).rejects.toThrow("Timeout");
    });

    it("times out if no matching message arrives", async () => {
      const waitPromise = bus.waitForMessage(
        researcher.id,
        "clarification:reply",
        "task-1",
        100 // 100ms timeout
      );

      await expect(waitPromise).rejects.toThrow("Timeout");
    });
  });

  // ---- Reset ----

  describe("reset", () => {
    it("clears all listeners and the message log", () => {
      const received: AgentMessage[] = [];
      bus.subscribe(researcher.id, (msg) => received.push(msg));
      bus.send(makeMessage());

      bus.reset();

      // Log should be empty
      expect(bus.getMessageLog()).toHaveLength(0);

      // Subscriber should no longer receive messages
      bus.send(makeMessage({ id: "msg-after-reset" }));
      expect(received).toHaveLength(1); // Only the pre-reset message
    });
  });
});
