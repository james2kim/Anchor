import { ChatAnthropic } from '@langchain/anthropic';

export const MAX_TOOL_ATTEMPTS = 3;

// Summarization thresholds
// At MAX_MESSAGES, summarize oldest MESSAGES_TO_SUMMARIZE and keep the rest
// Result: messages oscillate between MESSAGES_TO_KEEP and MAX_MESSAGES
export const MAX_MESSAGES = 15; // Trigger summarization when reached
export const MESSAGES_TO_SUMMARIZE = 10; // Oldest N messages to summarize
export const MESSAGES_TO_KEEP = 5; // Newest N messages to retain (MAX_MESSAGES - MESSAGES_TO_SUMMARIZE)

export const haikuModel = new ChatAnthropic({
  model: 'claude-haiku-4-5-20251001',
  apiKey: process.env.ANTHROPIC_API_KEY,
});

export const sonnetModel = new ChatAnthropic({
  model: 'claude-sonnet-4-5-20250929',
  apiKey: process.env.ANTHROPIC_API_KEY,
  clientOptions: {
    defaultHeaders: {
      'anthropic-beta': 'prompt-caching-2024-07-31',
    },
  },
});
