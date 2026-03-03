import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import type { BaseMessage } from '@langchain/core/messages';
import type { Message } from '../schemas/types';
import { z } from 'zod/v4';
import { haikuModel } from '../agent/constants';
import { withRetry } from '../util/RetryUtil';

const MAX_SUMMARY_CHARS = 2500;
const COMPRESSION_THRESHOLD = 2400; // Start compressing before hitting hard limit

// Relaxed schema for initial summarization (allows overflow)
const relaxedSummarizationSchema = z.object({
  confidence: z.number().min(0).max(1),
  content: z.string().min(50),
});

const SUMMARIZE_MESSAGES_SYSTEM_PROMPT = `You are a conversation summarizer for a persistent memory system. Your task is to extract and condense the most critical information from a conversation into a brief summary.

Focus ONLY on these essential elements:
1. DECISIONS - What was decided or agreed upon
2. CONSTRAINTS - Limitations, requirements, or boundaries established
3. USER GOALS - What the user is trying to accomplish
4. AGENT COMMITMENTS - What the agent promised or agreed to do
5. STATE CHANGES - Important changes to files, configurations, or system state

Rules:
- Be concise but thorough (max 2500 characters)
- Omit greetings, pleasantries, and filler
- Use shorthand and abbreviations where clear
- Prioritize actionable information over context
- If nothing important was discussed, note "No significant state changes"
- If an existing summary is provided, MERGE it with new information from the conversation
- When merging, preserve all essential details from the existing summary and add new ones
- Remove duplicates and consolidate overlapping information
- The final summary must still fit within 2500 characters

Output your confidence (0-1) based on how much essential information was present in the combined summary.`;

const modelWithRelaxedSchema = haikuModel.withStructuredOutput(relaxedSummarizationSchema);

const COMPRESS_SUMMARY_PROMPT = `You are a summary compressor. Your task is to condense the given summary while preserving ALL critical information.

Current summary length: {{LENGTH}} characters
Target: under ${COMPRESSION_THRESHOLD} characters

Rules:
- Keep ALL decisions, constraints, goals, and commitments
- Use extreme abbreviations (e.g., "user" → "U", "assistant" → "A")
- Remove articles, filler words, and redundant phrases
- Combine related items into single statements
- Use symbols where possible (→, =, &, w/, etc.)
- If you absolutely cannot fit everything, prioritize: decisions > goals > state changes > context

Output ONLY the compressed summary text, nothing else.`;

async function compressSummary(content: string, maxAttempts = 1): Promise<string> {
  let current = content;
  let attempts = 0;

  while (current.length > COMPRESSION_THRESHOLD && attempts < maxAttempts) {
    attempts++;
    const response = await withRetry(
      () => haikuModel.invoke([
        {
          role: 'system',
          content: COMPRESS_SUMMARY_PROMPT.replace('{{LENGTH}}', String(current.length)),
        },
        { role: 'user', content: current },
      ]),
      { label: 'compressSummary' }
    );

    const compressed =
      typeof response.content === 'string' ? response.content : JSON.stringify(response.content);

    // If compression didn't help, break to avoid infinite loop
    if (compressed.length >= current.length) {
      break;
    }

    current = compressed;
  }

  // Hard truncate as last resort (should rarely happen)
  if (current.length > MAX_SUMMARY_CHARS) {
    current = current.slice(0, MAX_SUMMARY_CHARS - 3) + '...';
  }

  return current;
}

const getMessageRole = (msg: BaseMessage): string => {
  const type = msg.constructor.name;
  if (type === 'HumanMessage') return 'user';
  if (type === 'AIMessage') return 'assistant';
  if (type === 'SystemMessage') return 'system';
  if (type === 'ToolMessage') return 'tool';
  return 'unknown';
};

export const summarize = async (existingSummary: string, messages: BaseMessage[]) => {
  const formattedMessages = messages
    .map(
      (m) =>
        `[${getMessageRole(m)}]: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`
    )
    .join('\n');

  const existingSummarySection = existingSummary
    ? `\n\nEXISTING SUMMARY TO MERGE:\n${existingSummary}`
    : '';

  // Use relaxed schema to allow overflow, then compress if needed
  const response = await withRetry(
    () => modelWithRelaxedSchema.invoke([
      { role: 'system', content: SUMMARIZE_MESSAGES_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Summarize this conversation and merge with any existing summary:${existingSummarySection}\n\nNEW CONVERSATION:\n${formattedMessages}`,
      },
    ]),
    { label: 'summarize' }
  );

  // Compress if summary exceeds threshold
  let finalContent = response.content;
  if (finalContent.length > COMPRESSION_THRESHOLD) {
    console.log(
      `[summarize] Summary exceeds threshold (${finalContent.length} chars), compressing...`
    );
    finalContent = await compressSummary(finalContent);
    console.log(`[summarize] Compressed to ${finalContent.length} chars`);
  }

  return {
    confidence: response.confidence,
    content: finalContent,
  };
};

/**
 * Summarize plain session messages (for stale session archival).
 */
export const summarizeSessionMessages = async (
  existingSummary: string,
  messages: Message[]
): Promise<{ confidence: number; content: string }> => {
  const formattedMessages = messages.map((m) => `[${m.role}]: ${m.content}`).join('\n');

  const existingSummarySection = existingSummary
    ? `\n\nEXISTING SUMMARY TO MERGE:\n${existingSummary}`
    : '';

  const response = await withRetry(
    () => modelWithRelaxedSchema.invoke([
      { role: 'system', content: SUMMARIZE_MESSAGES_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Summarize this conversation and merge with any existing summary:${existingSummarySection}\n\nNEW CONVERSATION:\n${formattedMessages}`,
      },
    ]),
    { label: 'summarizeSession' }
  );

  let finalContent = response.content;
  if (finalContent.length > COMPRESSION_THRESHOLD) {
    console.log(`[summarizeSession] Compressing summary (${finalContent.length} chars)...`);
    finalContent = await compressSummary(finalContent);
  }

  return {
    confidence: response.confidence,
    content: finalContent,
  };
};
