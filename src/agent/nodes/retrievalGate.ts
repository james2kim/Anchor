import type { AgentState } from '../../schemas/types';
import { rewriteQuery } from '../../llm/queryRewriter';
import { retrievalGateAssessor, retrievalGatePolicy } from '../../llm/retrievalAssessor';
import { defaultEmbedding } from '../../services/EmbeddingService';
import { TraceUtil } from '../../util/TraceUtil';

const CONTEXT_MESSAGES_FOR_REWRITE = 4;

export const retrievalGate = async (state: AgentState) => {
  const originalQuery = state.userQuery;
  const span = TraceUtil.startSpan('retrievalGate');

  let trace = TraceUtil.createTrace(originalQuery);

  const recentMessages = state.messages.slice(-CONTEXT_MESSAGES_FOR_REWRITE - 1, -1);
  const conversationContext = recentMessages
    .map((m) => {
      const role = m.constructor.name === 'HumanMessage' ? 'User' : 'Assistant';
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      const truncated = content.length > 300 ? content.slice(0, 300) + '...' : content;
      return `${role}: ${truncated}`;
    })
    .join('\n');

  const { rewrittenQuery, wasRewritten } = await rewriteQuery(originalQuery, conversationContext);

  const queryForProcessing = rewrittenQuery;

  const [assessment, queryEmbedding] = await Promise.all([
    retrievalGateAssessor(queryForProcessing),
    defaultEmbedding.embedText(queryForProcessing, 'query').catch((err) => {
      console.warn('[retrievalGate] Embedding failed, falling back to keyword-only:', err instanceof Error ? err.message : err);
      return null;
    }),
  ]);

  const decision = retrievalGatePolicy(assessment);

  const skipRetrieval = !decision.shouldRetrieveDocuments && !decision.shouldRetrieveMemories;

  trace = span.end(trace, {
    originalQuery,
    rewrittenQuery: wasRewritten ? rewrittenQuery : null,
    wasRewritten,
    queryType: assessment.queryType,
    referencesPersonalContext: assessment.referencesPersonalContext,
    shouldRetrieveDocuments: decision.shouldRetrieveDocuments,
    shouldRetrieveMemories: decision.shouldRetrieveMemories,
    needsClarification: decision.needsClarification,
    skipRetrieval,
  });

  return {
    gateDecision: decision,
    queryEmbedding: queryEmbedding ?? undefined,
    userQuery: queryForProcessing,
    trace,
    ...(skipRetrieval && { retrievedContext: { documents: [], memories: [] } }),
  };
};
