import type { AgentState } from '../../schemas/types';
import type { BaseMessage } from '@langchain/core/messages';
import { sonnetModel, haikuModel } from '../constants';
import { SYSTEM_MESSAGE, buildContextBlock } from '../../llm/promptBuilder';
import { TraceUtil } from '../../util/TraceUtil';
import { withRetry } from '../../util/RetryUtil';
import { SystemMessage, HumanMessage, AIMessage } from '@langchain/core/messages';

// Route to Haiku if retrieval is relevant
const MIN_CHUNKS_FOR_HAIKU = 2;
const MAX_DISTANCE_FOR_HAIKU = 0.6;

// Message truncation settings (Lost in the Middle strategy)
// Keep beginning + end, drop middle for long messages
const MAX_TOKENS_PER_MESSAGE = 400;
const KEEP_START_TOKENS = 300;
const KEEP_END_TOKENS = 100;
const TRUNCATION_THRESHOLD = 450; // Only truncate if above this

/**
 * Truncates a message using "Lost in the Middle" strategy.
 * Keeps beginning (300 tokens) + end (100 tokens), drops middle.
 * LLMs attend most to start and end of context.
 */
const truncateMessage = (content: string): { text: string; truncated: boolean } => {
  const estimatedTokens = Math.ceil(content.length / 4);

  if (estimatedTokens <= TRUNCATION_THRESHOLD) {
    return { text: content, truncated: false };
  }

  const startChars = KEEP_START_TOKENS * 4;
  const endChars = KEEP_END_TOKENS * 4;
  const droppedTokens = estimatedTokens - MAX_TOKENS_PER_MESSAGE;

  const start = content.slice(0, startChars);
  const end = content.slice(-endChars);

  return {
    text: `${start}\n\n[...${droppedTokens} tokens truncated...]\n\n${end}`,
    truncated: true,
  };
};

/**
 * Applies truncation to assistant messages only.
 * Human and system messages are kept intact for predictability.
 */
const truncateMessages = (messages: BaseMessage[]): { messages: BaseMessage[]; truncatedCount: number } => {
  let truncatedCount = 0;

  const truncated = messages.map((msg) => {
    // Only truncate assistant (AI) messages
    if (msg.constructor.name !== 'AIMessage') {
      return msg;
    }

    const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
    const { text, truncated: wasTruncated } = truncateMessage(content);

    if (wasTruncated) truncatedCount++;

    return new AIMessage({ content: text, additional_kwargs: msg.additional_kwargs });
  });

  return { messages: truncated, truncatedCount };
};

export const injectContext = async (state: AgentState) => {
  const span = TraceUtil.startSpan('injectContext');
  let trace = state.trace!;

  const documents = state.retrievedContext?.documents ?? [];
  const memories = state.retrievedContext?.memories ?? [];

  // Route decision:
  // - No context needed (conversational) → Haiku (fast)
  // - Good retrieval (low distance) → Haiku (synthesis)
  // - Weak retrieval → Sonnet (better at "I don't know")
  const topDistance = documents[0]?.distance ?? 1;

  const hasGoodRetrieval =
    documents.length >= MIN_CHUNKS_FOR_HAIKU && topDistance <= MAX_DISTANCE_FOR_HAIKU;
  const noContextNeeded = documents.length === 0 && memories.length === 0;

  const useHaiku = hasGoodRetrieval || noContextNeeded;
  const model = useHaiku ? haikuModel : sonnetModel;
  const modelName = useHaiku ? 'haiku' : 'sonnet';

  console.log(
    `[injectContext] Using ${modelName} (dist=${topDistance.toFixed(3)}, chunks=${documents.length})`
  );

  const contextBlock = buildContextBlock(documents, memories);
  const contextTokens = contextBlock ? Math.ceil(contextBlock.length / 4) : 0;

  const userQuery = state.userQuery;

  const userContent = contextBlock ? `${userQuery}\n\n${contextBlock}` : userQuery;

  // Get previous messages (exclude the current user message which is last)
  // Summarization keeps message count between 5-15, so we send all previous messages
  const rawPreviousMessages = state.messages.slice(0, -1);

  // Apply "Lost in the Middle" truncation to long messages
  // Keeps first 300 tokens + last 100 tokens, drops middle
  const { messages: previousMessages, truncatedCount } = truncateMessages(rawPreviousMessages);
  if (truncatedCount > 0) {
    console.log(`[injectContext] Truncated ${truncatedCount}/${rawPreviousMessages.length} messages`);
  }

  // Build system message with summary if available
  // Include summary in system message so the whole prefix can be cached together
  let systemContent = SYSTEM_MESSAGE;
  if (state.summary && state.summary.length > 0) {
    systemContent = `${SYSTEM_MESSAGE}\n\n## Conversation Summary (older context)\n${state.summary}`;
  }

  // Create system message with cache_control for prompt caching
  // This caches the system prompt + summary, reducing latency on subsequent requests
  const systemMessage = new SystemMessage({
    content: systemContent,
    additional_kwargs: {
      cache_control: { type: 'ephemeral' },
    },
  });

  const messagesForLLM = [systemMessage, ...previousMessages, new HumanMessage(userContent)];

  // Estimate total input tokens for logging
  const systemTokens = Math.ceil(systemContent.length / 4);
  const messageTokens = previousMessages.reduce(
    (sum, m) => sum + Math.ceil((typeof m.content === 'string' ? m.content.length : 100) / 4),
    0
  );
  const userTokens = Math.ceil(userContent.length / 4);
  const estimatedInputTokens = systemTokens + messageTokens + userTokens;

  console.log(
    `[injectContext] Input: ~${estimatedInputTokens} tokens (system=${systemTokens}, msgs=${messageTokens}, user=${userTokens})`
  );

  const startTime = Date.now();
  const aiMessage = await withRetry(() => model.invoke(messagesForLLM), { label: 'injectContext' });
  const durationMs = Date.now() - startTime;

  const response =
    typeof aiMessage.content === 'string' ? aiMessage.content : JSON.stringify(aiMessage.content);

  // Extract usage stats if available
  const usage = aiMessage.usage_metadata;
  const inputTokens = usage?.input_tokens;
  const outputTokens = usage?.output_tokens;

  console.log(
    `[injectContext] ${modelName} completed in ${(durationMs / 1000).toFixed(2)}s` +
      (inputTokens ? ` (in=${inputTokens}, out=${outputTokens})` : '')
  );

  trace = span.end(trace, {
    model: modelName,
    topDistance,
    documentsUsed: documents.length,
    memoriesUsed: memories.length,
    contextTokens,
    hasContext: contextBlock !== null,
    responseLength: response.length,
    messagesInContext: previousMessages.length,
    messagesTruncated: truncatedCount,
    hasSummary: state.summary && state.summary.length > 0,
    durationMs,
    inputTokens: inputTokens ?? null,
    outputTokens: outputTokens ?? null,
  });

  // Finalize trace - this is now the terminal node for success path
  trace = TraceUtil.setOutcome(trace, { status: 'success' });
  trace = TraceUtil.pruneTrace(trace);
  const traceSummary = TraceUtil.createTraceSummary(trace);

  return {
    messages: [aiMessage],
    response,
    trace,
    traceSummary,
    finalAction: 'ANSWER' as const,
  };
};
