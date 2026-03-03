import type { AgentState, DocumentChunk, Memory } from '../../schemas/types';
import { MemoryUtil } from '../../util/MemoryUtil';
import { DocumentUtil, type RetrievalDiagnostics } from '../../util/DocumentUtil';
import { DocumentStore } from '../../stores/DocumentStore';
import { MemoryStore } from '../../stores/MemoryStore';
import { db } from '../../db/knex';
import { TraceUtil } from '../../util/TraceUtil';

const documentStore = new DocumentStore(db, 1024);

export const retrieveMemoriesAndChunks = async (state: AgentState) => {
  const span = TraceUtil.startSpan('retrieveMemoriesAndChunks');
  let trace = state.trace!;

  const decision = state.gateDecision;
  const query = state.userQuery;
  const userId = state.userId;
  const queryEmbedding = state.queryEmbedding;

  const embeddingAvailable = !!queryEmbedding;

  const retrievalTasks: Promise<void>[] = [];
  const documents: DocumentChunk[] = [];
  const memories: Memory[] = [];
  let profileMemoryCount = 0;
  let contextualMemoryCount = 0;
  let retrievalDiagnostics: RetrievalDiagnostics | null = null;

  if (decision?.shouldRetrieveMemories) {
    // Two-tier memory retrieval:
    // 1. Always fetch profile memories (preferences + facts) - no embedding needed
    // 2. Similarity search for contextual memories (goals, decisions, etc.) - requires embedding

    const isFullBudget = decision.memoryBudget === 'full';
    const profileLimit = isFullBudget ? 3 : 2;
    const contextualLimit = isFullBudget ? 2 : 0;

    // Tier 1: Profile memories (always relevant for personalization)
    retrievalTasks.push(
      MemoryStore.listProfileMemories({
        user_id: userId,
        limit: profileLimit,
        minConfidence: 0.6,
      }).then((profileMemories) => {
        profileMemoryCount = profileMemories.length;
        memories.push(...profileMemories);
      })
    );

    // Tier 2: Contextual memories via similarity search (requires embedding)
    if (embeddingAvailable) {
      retrievalTasks.push(
        MemoryUtil.retrieveRelevantMemories(userId, query, {
          maxResults: contextualLimit,
          maxTokens: isFullBudget ? 300 : 150,
          minConfidence: 0.5,
          queryEmbedding,
          allowedTypes: ['goal', 'decision', 'summary'],
        }).then((result) => {
          if (result.success) {
            contextualMemoryCount = result.memories.length;
            memories.push(...result.memories);
          }
        })
      );
    }
  }

  if (decision?.shouldRetrieveDocuments) {
    retrievalTasks.push(
      DocumentUtil.retrieveRelevantChunks(
        documentStore,
        {
          queryEmbedding: queryEmbedding ?? undefined,
          user_id: userId,
          topK: 30,
          userQuery: state.userQuery,
        },
        {
          maxPerDoc: 4,
          maxChunks: 8,
        }
      )
        .then((result) => {
          documents.push(...result.chunks);
          retrievalDiagnostics = result.diagnostics;
        })
        .catch(() => {
          // Error handled silently, documents will be empty
        })
    );
  }

  await Promise.all(retrievalTasks);

  // Build trace metadata with richer diagnostics
  const traceMeta: Record<string, string | number | boolean | null> = {
    chunksRetrieved: documents.length,
    memoriesRetrieved: memories.length,
    profileMemories: profileMemoryCount,
    contextualMemories: contextualMemoryCount,
    embeddingFallback: !embeddingAvailable,
  };

  if (retrievalDiagnostics !== null) {
    const diag = retrievalDiagnostics as RetrievalDiagnostics;
    // Hybrid search stage
    traceMeta.embeddingCandidates = diag.hybridSearch.embeddingCandidates;
    traceMeta.keywordCandidates = diag.hybridSearch.keywordCandidates;
    traceMeta.fusionOverlap = diag.hybridSearch.overlapCount;
    traceMeta.fusedCount = diag.hybridSearch.fusedCount;
    // Pipeline stages
    traceMeta.afterRelevanceFilter = diag.afterRelevanceFilter;
    traceMeta.afterDedup = diag.afterDedup;
    traceMeta.afterBudget = diag.afterBudget;
    // Quality signals
    traceMeta.topChunkDistance = diag.topChunkDistance;
    traceMeta.topEmbeddingDistance = diag.hybridSearch.topEmbeddingDistance;
    traceMeta.scoreSpread = diag.scoreSpread;
    traceMeta.uniqueDocuments = diag.uniqueDocuments;
    // Temporal
    traceMeta.temporalFilterApplied = diag.temporalFilterApplied;
    traceMeta.queryYear = diag.queryYear;
  }

  // Add pruned candidate summaries (no full content, just ids + scores + snippets)
  if (documents.length > 0) {
    const candidateSummaries = TraceUtil.createCandidateSummaries(documents);
    traceMeta.topCandidates = JSON.stringify(candidateSummaries);
  }

  trace = span.end(trace, traceMeta);

  return {
    retrievedContext: {
      documents,
      memories,
    },
    trace,
  };
};
