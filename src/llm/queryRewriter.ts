import { haikuModel } from '../agent/constants';
import { withRetry } from '../util/RetryUtil';
import { z } from 'zod/v4';

const topicSchema = z.object({
  topic: z
    .string()
    .describe('The most recent topic being discussed, as a short noun phrase'),
});

const TOPIC_EXTRACTION_PROMPT = `Extract the most recent topic from the conversation context.
Return a short noun phrase (2-6 words) describing what was most recently discussed.
The context is ordered most-recent-first — use the FIRST substantive topic you see.
If no clear topic exists, return "unknown".`;

const modelWithSchema = haikuModel.withStructuredOutput(topicSchema);

// Patterns that indicate a pronoun/reference that needs resolving
const REFERENCE_PATTERNS = /\b(it|this|that|these|those|the same|more|again)\b/i;
const IMPLICIT_PATTERNS = /^(clarify|elaborate|explain|expand|why\??|how come|what do you mean)$/i;

/**
 * Rewrites a query to resolve pronouns and references using conversation context.
 * Uses a two-step approach: (1) extract topic via LLM, (2) substitute programmatically.
 * This avoids hallucination from asking the LLM to rewrite the full query.
 */
export async function rewriteQuery(
  query: string,
  conversationContext?: string
): Promise<{ rewrittenQuery: string; wasRewritten: boolean }> {
  if (!conversationContext || conversationContext.trim().length === 0) {
    return { rewrittenQuery: query, wasRewritten: false };
  }

  const isShortQuery = query.split(/\s+/).length <= 8;
  const hasReference = REFERENCE_PATTERNS.test(query);
  const isImplicitOnly = IMPLICIT_PATTERNS.test(query.trim());

  if (!hasReference && !isImplicitOnly) {
    return { rewrittenQuery: query, wasRewritten: false };
  }

  if (!isShortQuery && !isImplicitOnly) {
    return { rewrittenQuery: query, wasRewritten: false };
  }

  try {
    // Step 1: Extract topic from conversation context (LLM only does extraction, not rewriting)
    const response = await withRetry(
      () =>
        modelWithSchema.invoke([
          { role: 'system', content: TOPIC_EXTRACTION_PROMPT },
          { role: 'user', content: conversationContext },
        ]),
      { label: 'topicExtraction' }
    );

    const topic = response.topic?.trim();
    if (!topic || topic === 'unknown') {
      return { rewrittenQuery: query, wasRewritten: false };
    }

    // Step 2: Programmatic substitution — replace the pronoun with the extracted topic
    let rewritten: string;
    if (isImplicitOnly) {
      // "explain" → "explain [topic]"
      rewritten = `${query.trim()} ${topic}`;
    } else {
      // "make me a quiz on it" → "make me a quiz on [topic]"
      rewritten = query.replace(REFERENCE_PATTERNS, topic);
    }

    // Sanity check: don't use if the rewrite looks wrong
    if (rewritten.toLowerCase() === query.toLowerCase()) {
      return { rewrittenQuery: query, wasRewritten: false };
    }

    console.log(`[queryRewriter] "${query}" → "${rewritten}" (topic: "${topic}")`);
    return { rewrittenQuery: rewritten, wasRewritten: true };
  } catch (error) {
    console.warn('[queryRewriter] Failed to rewrite, using original:', error);
    return { rewrittenQuery: query, wasRewritten: false };
  }
}
