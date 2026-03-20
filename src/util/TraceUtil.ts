import crypto from 'crypto';
import type { AgentTrace, TraceSpan, TraceOutcome, TraceSummary } from '../schemas/types';

/**
 * Trace pruning limits to prevent memory bloat.
 * Traces are for observability, not a secondary memory system.
 */
export const TRACE_LIMITS = {
  MAX_RUNS_PER_SESSION: 50,
  MAX_SPANS_PER_RUN: 100,
  MAX_CANDIDATES_PER_RETRIEVAL: 10,
  MAX_BYTES_PER_RUN: 100 * 1024, // 100 KB
  MAX_SNIPPET_LENGTH: 100, // chars for content snippets
  MAX_QUERY_LENGTH: 500, // chars for query text
};

/**
 * Pruned candidate summary - lightweight representation of a retrieved chunk.
 */
export type CandidateSummary = {
  id: string;
  documentId: string;
  score: number; // distance or confidence
  snippet: string; // first N chars of content
};

export const TraceUtil = {
  /**
   * Creates a new trace for a query.
   */
  createTrace(query: string): AgentTrace {
    return {
      traceId: crypto.randomUUID(),
      queryId: crypto.randomUUID(),
      query,
      startTime: Date.now(),
      spans: [],
      outcome: null,
    };
  },

  /**
   * Creates a span and appends it to the trace.
   * Returns the updated trace (immutable).
   */
  addSpan(
    trace: AgentTrace,
    node: string,
    startTime: number,
    meta: Record<string, string | number | boolean | null> = {}
  ): AgentTrace {
    const span: TraceSpan = {
      node,
      startTime,
      durationMs: Date.now() - startTime,
      meta,
    };

    return {
      ...trace,
      spans: [...trace.spans, span],
    };
  },

  /**
   * Helper to create a span timer.
   * Usage:
   *   const span = TraceUtil.startSpan('retrievalGate');
   *   // ... do work ...
   *   trace = span.end(trace, { chunksRetrieved: 10 });
   */
  startSpan(node: string) {
    const startTime = Date.now();

    return {
      end(
        trace: AgentTrace,
        meta: Record<string, string | number | boolean | null> = {}
      ): AgentTrace {
        return TraceUtil.addSpan(trace, node, startTime, meta);
      },
    };
  },

  /**
   * Sets the final outcome on the trace.
   * Returns the updated trace (immutable).
   */
  setOutcome(trace: AgentTrace, outcome: Omit<TraceOutcome, 'durationMs'>): AgentTrace {
    return {
      ...trace,
      outcome: {
        ...outcome,
        durationMs: Date.now() - trace.startTime,
      },
    };
  },

  /**
   * Extracts key metrics from a trace for logging/export.
   */
  getTraceMetrics(trace: AgentTrace) {
    const retrievalSpan = trace.spans.find((s) => s.node === 'retrieveMemoriesAndChunks');
    const gateSpan = trace.spans.find((s) => s.node === 'retrievalGate');

    return {
      traceId: trace.traceId,
      query: trace.query,
      totalDurationMs: trace.outcome?.durationMs ?? Date.now() - trace.startTime,
      spanCount: trace.spans.length,
      outcome: trace.outcome?.status ?? 'pending',
      outcomeReason: trace.outcome?.reason,

      // Retrieval metrics
      chunksRetrieved: retrievalSpan?.meta.chunksRetrieved as number | undefined,
      memoriesRetrieved: retrievalSpan?.meta.memoriesRetrieved as number | undefined,
      topChunkDistance: retrievalSpan?.meta.topChunkDistance as number | undefined,
      temporalFilterApplied: retrievalSpan?.meta.temporalFilterApplied as boolean | undefined,

      // Gate metrics
      queryType: gateSpan?.meta.queryType as string | undefined,
      shouldRetrieveDocuments: gateSpan?.meta.shouldRetrieveDocuments as boolean | undefined,
      shouldRetrieveMemories: gateSpan?.meta.shouldRetrieveMemories as boolean | undefined,
    };
  },

  /**
   * Creates a pruned candidate summary from a chunk.
   * Keeps only id, score, and a short snippet - no full content or embeddings.
   */
  createCandidateSummary(chunk: {
    id?: string;
    document_id?: string;
    content?: string;
    distance?: number;
    confidence?: number;
  }): CandidateSummary {
    const content = chunk.content ?? '';
    const snippet =
      content.length > TRACE_LIMITS.MAX_SNIPPET_LENGTH
        ? content.slice(0, TRACE_LIMITS.MAX_SNIPPET_LENGTH) + '...'
        : content;

    return {
      id: chunk.id ?? 'unknown',
      documentId: chunk.document_id ?? 'unknown',
      score: chunk.distance ?? chunk.confidence ?? 0,
      snippet: snippet.replace(/\s+/g, ' ').trim(),
    };
  },

  /**
   * Creates pruned candidate summaries from an array of chunks.
   * Limits to top N candidates.
   */
  createCandidateSummaries(
    chunks: Array<{
      id?: string;
      document_id?: string;
      content?: string;
      distance?: number;
      confidence?: number;
    }>
  ): CandidateSummary[] {
    return chunks
      .slice(0, TRACE_LIMITS.MAX_CANDIDATES_PER_RETRIEVAL)
      .map((c) => this.createCandidateSummary(c));
  },

  /**
   * Prunes a single trace run to fit within size limits.
   * - Truncates query if too long
   * - Limits spans to MAX_SPANS_PER_RUN
   * - Removes large metadata values if over byte limit
   */
  pruneTrace(trace: AgentTrace): AgentTrace {
    // Truncate query
    const prunedQuery =
      trace.query.length > TRACE_LIMITS.MAX_QUERY_LENGTH
        ? trace.query.slice(0, TRACE_LIMITS.MAX_QUERY_LENGTH) + '...'
        : trace.query;

    // Limit spans
    const prunedSpans = trace.spans.slice(-TRACE_LIMITS.MAX_SPANS_PER_RUN);

    let pruned: AgentTrace = {
      ...trace,
      query: prunedQuery,
      spans: prunedSpans,
    };

    // Check size and prune metadata if needed
    const size = this.estimateTraceSize(pruned);
    if (size > TRACE_LIMITS.MAX_BYTES_PER_RUN) {
      pruned = this.pruneTraceMetadata(pruned);
    }

    return pruned;
  },

  /**
   * Estimates the JSON size of a trace in bytes.
   */
  estimateTraceSize(trace: AgentTrace): number {
    return JSON.stringify(trace).length;
  },

  /**
   * Prunes large metadata values from spans.
   * Keeps numeric/boolean values, truncates or removes large strings/arrays.
   */
  pruneTraceMetadata(trace: AgentTrace): AgentTrace {
    const prunedSpans = trace.spans.map((span) => {
      const prunedMeta: Record<string, string | number | boolean | null> = {};

      for (const [key, value] of Object.entries(span.meta)) {
        if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
          prunedMeta[key] = value;
        } else if (typeof value === 'string') {
          // Truncate long strings
          prunedMeta[key] = value.length > 200 ? value.slice(0, 200) + '...' : value;
        }
        // Skip arrays/objects that might have been stringified
      }

      return { ...span, meta: prunedMeta };
    });

    return { ...trace, spans: prunedSpans };
  },

  /**
   * Prunes a session's trace history to keep only recent runs.
   * Call this before persisting to Redis.
   */
  pruneSessionTraces(traces: AgentTrace[]): AgentTrace[] {
    // Keep only the most recent N traces
    const recent = traces.slice(-TRACE_LIMITS.MAX_RUNS_PER_SESSION);

    // Prune each trace
    return recent.map((t) => this.pruneTrace(t));
  },

  /**
   * Creates a lightweight trace summary for evaluations.
   * Includes key metrics without full span details.
   */
  createTraceSummary(trace: AgentTrace): TraceSummary {
    const gateSpan = trace.spans.find((s) => s.node === 'retrievalGate');
    const retrievalSpan = trace.spans.find((s) => s.node === 'retrieveMemoriesAndChunks');

    const didRetrieval = retrievalSpan !== undefined;
    const documentsRetrieved = (retrievalSpan?.meta?.chunksRetrieved as number) ?? 0;
    const memoriesRetrieved = (retrievalSpan?.meta?.memoriesRetrieved as number) ?? 0;

    return {
      traceId: trace.traceId,
      queryType: gateSpan?.meta?.queryType as string | undefined,
      outcome: trace.outcome?.status,
      durationMs: trace.outcome?.durationMs,
      documentsRetrieved,
      memoriesRetrieved,
      didRetrieval,
    };
  },
};
