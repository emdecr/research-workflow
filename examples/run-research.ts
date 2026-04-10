/**
 * run-research.ts — Example script to run the agent workforce
 *
 * This is a standalone example you can use to test the system.
 * It runs a research question through the workforce and prints
 * the final report.
 *
 * USAGE:
 *   npx tsx examples/run-research.ts
 *
 * Or with a custom question:
 *   npx tsx examples/run-research.ts "Your question here"
 *
 * BEFORE RUNNING:
 *   1. Copy .env.example to .env
 *   2. Add your ANTHROPIC_API_KEY to .env
 *   3. npm install (if you haven't already)
 *
 * WHAT TO WATCH FOR IN THE OUTPUT:
 *
 *   MSG  — Messages between agents (the "conversation")
 *   TSK  — Task status changes (the "work board")
 *   API  — Claude API calls with token counts (the "cost meter")
 *   SYS  — System events (session start/end, agent registration)
 *   ERR  — Errors (tool failures, timeouts, etc.)
 *
 * The output is color-coded by agent role:
 *   Blue   = Coordinator
 *   Green  = Researcher
 *   Yellow = Synthesizer
 */

import { runWorkforce } from "../src/index.js";

// A good default question that exercises the system well.
// It's broad enough to decompose into multiple angles,
// specific enough to produce substantive findings.
const DEFAULT_QUESTION =
  "What are the main business implications of large language models (LLMs) " +
  "for mid-size companies (100-1000 employees) in 2026? Consider both " +
  "opportunities and risks.";

async function main() {
  // Use a custom question from command line, or the default
  const question = process.argv[2] ?? DEFAULT_QUESTION;

  console.log("\n");
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║          AI AGENT WORKFORCE — RESEARCH & REPORT         ║");
  console.log("╚══════════════════════════════════════════════════════════╝");
  console.log("\n");

  const report = await runWorkforce(question, {
    // You can tweak these for experimentation:
    // model: "claude-sonnet-4-20250514",  // or "claude-haiku-4-5-20251001" for cheaper testing
    // maxApiCalls: 50,                    // increase if you want deeper research
    // defaultMaxRetries: 1,               // reduce retries for faster runs
    // sessionTimeoutMs: 10 * 60 * 1000,   // 10 min timeout for complex questions
  });

  if (report) {
    console.log("Research completed successfully.");
  } else {
    console.log("Research session failed. Check the logs above for details.");
  }
}

main().catch(console.error);
