/**
 * claude-client.ts — Anthropic API client setup
 *
 * This module creates a single shared Anthropic client instance.
 * All agents use the same client (and therefore the same API key
 * and configuration).
 *
 * Why a separate module instead of creating the client inline?
 * 1. Single source of truth for API configuration
 * 2. Easy to swap in a mock client for testing
 * 3. Environment variable loading happens once, in one place
 */

import Anthropic from "@anthropic-ai/sdk";
import dotenv from "dotenv";

// Load .env file into process.env
// This must happen before we create the client, since the Anthropic
// SDK reads ANTHROPIC_API_KEY from the environment automatically.
dotenv.config();

/**
 * The shared Anthropic client.
 *
 * The SDK automatically reads ANTHROPIC_API_KEY from process.env.
 * If the key is missing, the SDK will throw a clear error when you
 * try to make your first API call (not at import time).
 */
export const client = new Anthropic();

/**
 * API call counter — tracks how many calls we've made across the
 * entire session. This is a simple cost-control mechanism.
 *
 * We track this here (not in individual agents) because the limit
 * is per-session, not per-agent. A Coordinator + 3 Researchers +
 * 1 Synthesizer all contribute to the same counter.
 */
let apiCallCount = 0;

export function incrementApiCallCount(): number {
  return ++apiCallCount;
}

export function getApiCallCount(): number {
  return apiCallCount;
}

export function resetApiCallCount(): void {
  apiCallCount = 0;
}
