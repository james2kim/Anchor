import type { AgentState, FinalAction, DocumentChunk } from '../../schemas/types';
import { TraceUtil } from '../../util/TraceUtil';
import { buildContextBlock } from '../../llm/promptBuilder';
import { routeToTool, getAvailableWorkflows, getToolByName } from '../../workflows/registry';
import { WorkflowRunStore } from '../../stores/WorkflowRunStore';
import { WorkflowRun } from '../../workflows/WorkflowRun';
import { AIMessage } from '@langchain/core/messages';
import { DocumentStore } from '../../stores/DocumentStore';
import { DocumentUtil } from '../../util/DocumentUtil';
import { defaultEmbedding } from '../../services/EmbeddingService';
import { db } from '../../db/knex';
import { withWorkflowContext, setWorkflowRunId, setWorkflowToolName, wlog } from '../../util/WorkflowLogger';

const workflowDocumentStore = new DocumentStore(db, 1024);

export const executeWorkflow = async (state: AgentState) => {
  return withWorkflowContext({ sessionId: state.sessionId }, () => executeWorkflowInner(state));
};

const executeWorkflowInner = async (state: AgentState) => {
  const outerSpan = TraceUtil.startSpan('executeWorkflow');
  let trace = state.trace!;
  let run: WorkflowRun | undefined;
  let lockId: string | null = null;

  try {
    // Acquire session-scoped mutex to prevent concurrent workflow corruption
    lockId = await WorkflowRunStore.acquireSessionLock(state.sessionId);
    if (!lockId) {
      const message = 'A workflow is already running for this session. Please wait for it to finish.';
      trace = outerSpan.end(trace, { routed: false, reason: 'lock_held' });
      trace = TraceUtil.setOutcome(trace, {
        status: 'clarified',
        reason: 'workflow_lock_held',
        triggeringSpan: 'executeWorkflow',
      });
      trace = TraceUtil.pruneTrace(trace);
      const traceSummary = TraceUtil.createTraceSummary(trace);
      return {
        messages: [new AIMessage(message)],
        response: message,
        trace,
        finalAction: 'CLARIFY' as FinalAction,
        traceSummary,
      };
    }

    const documents = state.retrievedContext?.documents ?? [];
    const memories = state.retrievedContext?.memories ?? [];
    const contextBlock = buildContextBlock(documents, memories);

    // Build conversation context from recent messages so workflows can
    // resolve references ("it", "this topic") even if the query rewrite failed.
    const CONTEXT_MSG_COUNT = 6;
    const recentMsgs = state.messages.slice(-CONTEXT_MSG_COUNT - 1, -1);
    const conversationContext = recentMsgs.length > 0
      ? recentMsgs
          .map((m) => {
            const role = m.constructor.name === 'HumanMessage' ? 'User' : 'Assistant';
            const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
            return `${role}: ${content.length > 400 ? content.slice(0, 400) + '...' : content}`;
          })
          .join('\n')
      : null;

    // ---- Route to the correct workflow tool ----
    const routingSpan = TraceUtil.startSpan('workflowRouting');
    const preResolved = state.matchedWorkflowTool
      ? getToolByName(state.matchedWorkflowTool)
      : null;
    const routeResult = preResolved
      ? { tool: preResolved, method: 'deterministic' as const }
      : routeToTool(state.userQuery);

    trace = routingSpan.end(trace, {
      selectedTool: routeResult?.tool.name ?? 'none',
      routingMethod: routeResult?.method ?? 'none',
      preResolved: preResolved != null,
    });

    if (!routeResult) {
      const workflows = getAvailableWorkflows();
      const workflowList = workflows.map((d) => `- ${d}`).join('\n');
      const message =
        `I wasn't able to match your request to an available workflow. Here's what I can do:\n\n${workflowList}\n\nCould you try rephrasing your request?`;

      trace = outerSpan.end(trace, { routed: false });
      trace = TraceUtil.setOutcome(trace, {
        status: 'clarified',
        reason: 'no_workflow_match',
        triggeringSpan: 'executeWorkflow',
      });
      trace = TraceUtil.pruneTrace(trace);
      const traceSummary = TraceUtil.createTraceSummary(trace);

      return {
        messages: [new AIMessage(message)],
        response: message,
        trace,
        finalAction: 'CLARIFY' as FinalAction,
        traceSummary,
      };
    }

    // ---- Create or resume durable workflow run ----
    const { record, resumed } = await WorkflowRunStore.getOrCreateRun(
      state.sessionId,
      routeResult.tool.name
    );
    run = new WorkflowRun(record, WorkflowRunStore);
    setWorkflowRunId(run.runId);
    setWorkflowToolName(routeResult.tool.name);
    wlog.log(
      `[executeWorkflow] ${resumed ? 'Resumed' : 'Created'} run ${run.runId} for ${routeResult.tool.name}`
    );

    // ---- Build in-workflow retriever ----
    const retrieve = async (query: string): Promise<DocumentChunk[]> => {
      try {
        const queryEmbedding = await defaultEmbedding.embedText(query, 'query');
        const { chunks } = await DocumentUtil.retrieveRelevantChunks(
          workflowDocumentStore,
          { queryEmbedding, user_id: state.userId, userQuery: query }
        );
        return chunks;
      } catch (err) {
        wlog.error('[executeWorkflow] In-workflow retrieval failed:', err);
        return [];
      }
    };

    // ---- Execute the selected tool ----
    const result = await routeResult.tool.execute(
      {
        userQuery: state.userQuery,
        contextBlock,
        documents,
        memories,
        trace,
        sessionId: state.sessionId,
        conversationContext,
        retrieve,
      },
      run
    );

    // ---- Mark run complete or failed (non-fatal — don't discard a good result) ----
    try {
      if (result.success) {
        await run.complete();
      } else {
        await run.fail(result.errorType);
      }
    } catch (persistErr) {
      wlog.error(
        '[executeWorkflow] Failed to persist run status (result still returned to user):',
        persistErr
      );
    }

    // ---- Finalize trace ----
    trace = outerSpan.end(result.trace, {
      selectedTool: routeResult.tool.name,
      routingMethod: routeResult.method,
      success: result.success,
      totalInputTokens: result.totalInputTokens,
      totalOutputTokens: result.totalOutputTokens,
      resumed,
    });

    trace = TraceUtil.setOutcome(trace, {
      status: result.success ? 'success' : 'error',
      reason: result.success
        ? `${routeResult.tool.name}_completed`
        : result.errorType,
      triggeringSpan: result.success ? undefined : 'executeWorkflow',
    });
    trace = TraceUtil.pruneTrace(trace);
    const traceSummary = TraceUtil.createTraceSummary(trace);

    return {
      messages: [new AIMessage(result.response)],
      response: result.response,
      trace,
      finalAction: result.finalAction,
      traceSummary,
      ...(result.data !== undefined && { workflowData: result.data }),
    };
  } catch (err) {
    wlog.error(
      '[executeWorkflow] Unhandled error:',
      err instanceof Error ? err.stack : err
    );

    if (run) {
      try {
        await run.fail(err instanceof Error ? err.message : String(err));
      } catch (failErr) {
        wlog.error('[executeWorkflow] Failed to mark run as failed:', failErr);
      }
    }

    const message = 'Something went wrong while generating study material. Please try again.';

    trace = outerSpan.end(trace, {
      error: err instanceof Error ? err.message : String(err),
    });
    trace = TraceUtil.setOutcome(trace, {
      status: 'error',
      reason: 'unhandled_error',
      triggeringSpan: 'executeWorkflow',
    });
    trace = TraceUtil.pruneTrace(trace);
    const traceSummary = TraceUtil.createTraceSummary(trace);

    return {
      messages: [new AIMessage(message)],
      response: message,
      trace,
      finalAction: 'CLARIFY' as FinalAction,
      traceSummary,
    };
  } finally {
    if (lockId) {
      WorkflowRunStore.releaseSessionLock(state.sessionId, lockId).catch((err) =>
        wlog.error('[executeWorkflow] Failed to release session lock:', err)
      );
    }
  }
};
