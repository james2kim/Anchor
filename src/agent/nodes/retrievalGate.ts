import type { AgentState } from '../../schemas/types';
import { rewriteQuery } from '../../llm/queryRewriter';
import { retrievalGateAssessor, retrievalGatePolicy } from '../../llm/retrievalAssessor';
import { defaultEmbedding } from '../../services/EmbeddingService';
import { TraceUtil } from '../../util/TraceUtil';

const CONTEXT_MESSAGES_NARROW = 2;
const CONTEXT_MESSAGES_WIDE = 4;
const FILLER_PATTERN = /^(thanks|thank you|ok|okay|got it|sure|yes|no|bye|goodbye|hi|hello|hey|great|cool|nice|perfect|awesome)[\s!.,?]*$/i;

export const retrievalGate = async (state: AgentState) => {
  const originalQuery = state.userQuery;
  const span = TraceUtil.startSpan('retrievalGate');

  let trace = TraceUtil.createTrace(originalQuery);

  // Build conversation context for the query rewriter.
  // Use a narrow window (last 2 messages) to avoid stale topics competing with the current one.
  // Fall back to a wider window (4 messages) if the narrow window is all filler ("thanks", "ok").
  // Reverse so most recent exchange appears first (exploits LLM primacy bias).
  const narrowMsgs = state.messages.slice(-CONTEXT_MESSAGES_NARROW - 1, -1);
  const hasSubstance = narrowMsgs.some((m) => {
    if (m.constructor.name !== 'HumanMessage') return false;
    const content = typeof m.content === 'string' ? m.content : '';
    return !FILLER_PATTERN.test(content.trim());
  });
  const recentMessages = hasSubstance
    ? narrowMsgs
    : state.messages.slice(-CONTEXT_MESSAGES_WIDE - 1, -1);
  const conversationContext = recentMessages
    .map((m) => {
      const role = m.constructor.name === 'HumanMessage' ? 'User' : 'Assistant';
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      const truncated = content.length > 500 ? content.slice(0, 500) + '...' : content;
      return `${role}: ${truncated}`;
    })
    .reverse()
    .join('\n');

  const { rewrittenQuery, wasRewritten } = await rewriteQuery(originalQuery, conversationContext);

  const queryForProcessing = rewrittenQuery;

  const [assessorResult, queryEmbedding] = await Promise.all([
    retrievalGateAssessor(queryForProcessing),
    defaultEmbedding.embedText(queryForProcessing, 'query').catch((err) => {
      console.warn(
        '[retrievalGate] Embedding failed, falling back to keyword-only:',
        err instanceof Error ? err.message : err
      );
      return null;
    }),
  ]);

  const { assessment, matchedWorkflowTool } = assessorResult;
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
    matchedWorkflowTool,
    ...(skipRetrieval && { retrievedContext: { documents: [], memories: [] } }),
  };
};
