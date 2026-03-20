import type { WorkflowResult, WorkflowSuccess, WorkflowFailure } from './types';
import type { WorkflowRun } from './WorkflowRun';
import { WorkflowStepError } from './errors';
import { TraceUtil } from '../util/TraceUtil';
import type { AgentTrace } from '../schemas/types';
import { wlog } from '../util/WorkflowLogger';
import { ProgressEmitter } from '../util/ProgressEmitter';

/**
 * Shape of a step artifact that carries LLM usage info.
 * `runStep` auto-accumulates tokens from artifacts matching this shape.
 */
interface UsageArtifact {
  usage: { inputTokens: number | null; outputTokens: number | null };
  durationMs: number;
}

/**
 * A mapping from WorkflowStepError codes to user-facing failure messages.
 * `onError` is called when the code matches — use for tool-specific observability
 * (e.g. schema validation of failure payloads, logging error details).
 */
export interface ErrorMapping {
  code: string;
  message: string;
  errorType: string;
  onError?: (err: WorkflowStepError) => void;
}

type SpanMetaFn<T> = (artifact: T, cached: boolean) => Record<string, string | number | boolean | null>;

interface RunStepOptions<T> {
  /** Extra metadata to attach to the trace span. */
  spanMeta?: SpanMetaFn<T>;
  /** Passed through to WorkflowRun.executeStep. */
  durable?: boolean;
  /** Step-level timeout in ms. Wraps the entire step (including retries). */
  timeoutMs?: number;
  /** User-facing label for progress display (e.g. "Generating questions...") */
  progressLabel?: string;
}

export class WorkflowRunner {
  private run: WorkflowRun;
  private trace: AgentTrace;
  private totalInputTokens = 0;
  private totalOutputTokens = 0;
  private sessionId: string | null = null;

  constructor(trace: AgentTrace, run: WorkflowRun, sessionId?: string) {
    this.run = run;
    this.trace = trace;
    this.sessionId = sessionId ?? null;
  }

  /**
   * Run a durable step with auto trace span + token accumulation.
   */
  async runStep<T>(
    stepName: string,
    spanName: string,
    fn: () => Promise<T>,
    opts?: RunStepOptions<T>
  ): Promise<T> {
    const label = opts?.progressLabel ?? stepName;

    // Emit progress: step starting
    if (this.sessionId) {
      ProgressEmitter.emit(this.sessionId, { step: stepName, status: 'running', label });
    }

    const span = TraceUtil.startSpan(spanName);
    const result = await this.run.executeStep<T>(stepName, fn, {
      durable: opts?.durable,
      timeoutMs: opts?.timeoutMs,
    });

    // Emit progress: step done
    if (this.sessionId) {
      ProgressEmitter.emit(this.sessionId, {
        step: stepName,
        status: result.cached ? 'cached' : 'completed',
        label,
      });
    }

    // Auto-accumulate tokens and build metadata in a single pass
    const artifact = result.artifact as unknown;
    const baseMeta: Record<string, string | number | boolean | null> = {
      cached: result.cached,
    };

    if (this.hasUsage(artifact)) {
      this.totalInputTokens += artifact.usage.inputTokens ?? 0;
      this.totalOutputTokens += artifact.usage.outputTokens ?? 0;
      baseMeta.durationMs = result.cached ? 0 : artifact.durationMs;
      baseMeta.inputTokens = artifact.usage.inputTokens ?? null;
      baseMeta.outputTokens = artifact.usage.outputTokens ?? null;
    }

    const extraMeta = opts?.spanMeta?.(result.artifact, result.cached) ?? {};
    this.trace = span.end(this.trace, { ...baseMeta, ...extraMeta });

    return result.artifact;
  }

  /** Build a WorkflowSuccess with accumulated tokens. */
  success(response: string, data?: unknown): WorkflowSuccess {
    const result: WorkflowSuccess = {
      success: true,
      response,
      trace: this.trace,
      finalAction: 'ANSWER',
      totalInputTokens: this.totalInputTokens,
      totalOutputTokens: this.totalOutputTokens,
    };
    if (data !== undefined) {
      result.data = data;
    }
    return result;
  }

  /**
   * Build a WorkflowFailure with accumulated tokens.
   * @param response   User-facing message
   * @param errorType  Machine-readable error category
   * @param errorMessage  Technical error detail (defaults to response if omitted)
   */
  failure(response: string, errorType: string, errorMessage?: string): WorkflowFailure {
    return {
      success: false,
      response,
      trace: this.trace,
      finalAction: 'CLARIFY',
      totalInputTokens: this.totalInputTokens,
      totalOutputTokens: this.totalOutputTokens,
      errorType,
      errorMessage: errorMessage ?? response,
    };
  }

  /**
   * Wrap the tool body — catches WorkflowStepError, maps via error table.
   * Calls `onError` on matched mappings for tool-specific observability.
   * Unknown errors produce a generic failure.
   */
  async execute(
    body: () => Promise<WorkflowResult>,
    errorMap: ErrorMapping[]
  ): Promise<WorkflowResult> {
    try {
      return await body();
    } catch (err) {
      if (err instanceof WorkflowStepError) {
        const mapping = errorMap.find((m) => m.code === err.code);
        if (mapping) {
          mapping.onError?.(err);
          return this.failure(mapping.message, mapping.errorType, err.message);
        }
        wlog.error(
          `[WorkflowRunner] Unmapped WorkflowStepError code "${err.code}":`,
          err.message
        );
        return this.failure(
          'Something went wrong. Please try again.',
          err.code,
          err.message
        );
      }

      wlog.error(
        '[WorkflowRunner] Unhandled error:',
        err instanceof Error ? err.stack : err
      );
      return this.failure(
        'Something went wrong. Please try again.',
        'unhandled_tool_error',
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  /** Get the current trace (for inline checks that need it). */
  get currentTrace(): AgentTrace {
    return this.trace;
  }

  private hasUsage(val: unknown): val is UsageArtifact {
    return (
      val != null &&
      typeof val === 'object' &&
      'usage' in val &&
      'durationMs' in val
    );
  }
}
