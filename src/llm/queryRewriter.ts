import { haikuModel } from '../agent/constants';
import { withRetry } from '../util/RetryUtil';
import { z } from 'zod/v4';

const rewriteSchema = z.object({
  rewrittenQuery: z.string().describe('The query with references resolved, or original if no rewrite needed'),
});

const REWRITE_SYSTEM_PROMPT = `Resolve references in the query using the conversation context.

Handle:
- Pronouns: "it", "this", "that" → replace with the ACTUAL topic from context
- Implicit references: "clarify", "explain", "why" → add the ACTUAL topic from context

Rules:
- Extract the topic from the provided context ONLY
- NEVER use topics from this prompt or examples
- If no clear topic in context, return query UNCHANGED
- Output the rewritten query, nothing else`;

const modelWithSchema = haikuModel.withStructuredOutput(rewriteSchema);

/**
 * Rewrites a query to resolve pronouns and references using conversation context.
 * Returns the original query if no rewrite is needed or possible.
 */
export async function rewriteQuery(
  query: string,
  conversationContext?: string
): Promise<{ rewrittenQuery: string; wasRewritten: boolean }> {
  // Skip rewrite if no context provided
  if (!conversationContext || conversationContext.trim().length === 0) {
    return { rewrittenQuery: query, wasRewritten: false };
  }

  // Quick heuristic: skip if query is already specific
  // Only rewrite SHORT queries with pronouns/references (longer queries are usually self-contained)
  const isShortQuery = query.split(/\s+/).length <= 6;
  const referencePatterns = /\b(it|this|that|these|those|the same|more|again)\b/i;
  const implicitPatterns = /^(clarify|elaborate|explain|expand|why\??|how come|what do you mean)$/i;

  const hasReference = referencePatterns.test(query);
  const isImplicitOnly = implicitPatterns.test(query.trim());

  if (!hasReference && !isImplicitOnly) {
    return { rewrittenQuery: query, wasRewritten: false };
  }

  // Skip rewriting longer queries that happen to contain pronouns - they're usually self-contained
  if (!isShortQuery && !isImplicitOnly) {
    return { rewrittenQuery: query, wasRewritten: false };
  }

  try {
    const response = await withRetry(
      () => modelWithSchema.invoke([
        { role: 'system', content: REWRITE_SYSTEM_PROMPT },
        {
          role: 'user',
          content: `Context:\n${conversationContext}\n\nQuery: "${query}"`,
        },
      ]),
      { label: 'queryRewriter' }
    );

    // Derive wasRewritten by comparing strings
    const wasRewritten = response.rewrittenQuery.toLowerCase() !== query.toLowerCase();

    if (wasRewritten) {
      console.log(`[queryRewriter] "${query}" → "${response.rewrittenQuery}"`);
    }

    return {
      rewrittenQuery: response.rewrittenQuery,
      wasRewritten,
    };
  } catch (error) {
    console.warn('[queryRewriter] Failed to rewrite, using original:', error);
    return { rewrittenQuery: query, wasRewritten: false };
  }
}
