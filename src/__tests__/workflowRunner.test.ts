import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WorkflowRunner } from '../workflows/WorkflowRunner';
import type { ErrorMapping } from '../workflows/WorkflowRunner';
import { WorkflowStepError } from '../workflows/errors';
import { TraceUtil } from '../util/TraceUtil';
import type { WorkflowRun, StepResult } from '../workflows/WorkflowRun';

/**
 * Creates a mock WorkflowRun that delegates to the provided fn.
 * Simulates executeStep by calling fn and wrapping the result.
 */
const createMockRun = (overrides?: Partial<WorkflowRun>): WorkflowRun => ({
  runId: 'test-run-id',
  status: 'running',
  getStep: vi.fn(),
  executeStep: vi.fn(async <T>(name: string, fn: () => Promise<T>): Promise<StepResult<T>> => {
    const artifact = await fn();
    return { artifact, cached: false };
  }),
  complete: vi.fn(),
  fail: vi.fn(),
  ...overrides,
} as unknown as WorkflowRun);

/**
 * Creates a mock WorkflowRun that returns cached artifacts.
 */
const createCachedRun = (cache: Record<string, unknown>): WorkflowRun => ({
  runId: 'test-run-id',
  status: 'running',
  getStep: vi.fn(),
  executeStep: vi.fn(async <T>(name: string): Promise<StepResult<T>> => {
    if (name in cache) {
      return { artifact: cache[name] as T, cached: true };
    }
    throw new Error(`No cached artifact for step "${name}"`);
  }),
  complete: vi.fn(),
  fail: vi.fn(),
} as unknown as WorkflowRun);

describe('WorkflowRunner', () => {
  let trace: ReturnType<typeof TraceUtil.createTrace>;

  beforeEach(() => {
    trace = TraceUtil.createTrace('test query');
  });

  describe('runStep', () => {
    it('should return the artifact from the step function', async () => {
      const run = createMockRun();
      const runner = new WorkflowRunner(trace, run);

      const result = await runner.runStep('step1', 'span1', async () => ({
        value: 42,
      }));

      expect(result).toEqual({ value: 42 });
    });

    it('should accumulate tokens from artifacts with usage info', async () => {
      const run = createMockRun();
      const runner = new WorkflowRunner(trace, run);

      await runner.runStep('step1', 'span1', async () => ({
        data: 'a',
        usage: { inputTokens: 100, outputTokens: 50 },
        durationMs: 500,
      }));

      await runner.runStep('step2', 'span2', async () => ({
        data: 'b',
        usage: { inputTokens: 200, outputTokens: 75 },
        durationMs: 300,
      }));

      const result = runner.success('done');
      expect(result.totalInputTokens).toBe(300);
      expect(result.totalOutputTokens).toBe(125);
    });

    it('should not accumulate tokens from artifacts without usage info', async () => {
      const run = createMockRun();
      const runner = new WorkflowRunner(trace, run);

      await runner.runStep('step1', 'span1', async () => ({
        valid: true,
        warnings: [],
      }));

      const result = runner.success('done');
      expect(result.totalInputTokens).toBe(0);
      expect(result.totalOutputTokens).toBe(0);
    });

    it('should handle null token counts in usage', async () => {
      const run = createMockRun();
      const runner = new WorkflowRunner(trace, run);

      await runner.runStep('step1', 'span1', async () => ({
        usage: { inputTokens: null, outputTokens: null },
        durationMs: 100,
      }));

      const result = runner.success('done');
      expect(result.totalInputTokens).toBe(0);
      expect(result.totalOutputTokens).toBe(0);
    });

    it('should accumulate tokens from cached artifacts', async () => {
      const cachedArtifact = {
        data: 'cached',
        usage: { inputTokens: 150, outputTokens: 60 },
        durationMs: 400,
      };
      const run = createCachedRun({ step1: cachedArtifact });
      const runner = new WorkflowRunner(trace, run);

      await runner.runStep('step1', 'span1', async () => {
        throw new Error('should not be called');
      });

      const result = runner.success('done');
      expect(result.totalInputTokens).toBe(150);
      expect(result.totalOutputTokens).toBe(60);
    });

    it('should add trace spans with base metadata', async () => {
      const run = createMockRun();
      const runner = new WorkflowRunner(trace, run);

      await runner.runStep('step1', 'mySpan', async () => ({
        usage: { inputTokens: 10, outputTokens: 5 },
        durationMs: 200,
      }));

      const resultTrace = runner.success('done').trace;
      const span = resultTrace.spans.find((s) => s.node === 'mySpan');
      expect(span).toBeDefined();
      expect(span!.meta.cached).toBe(false);
      expect(span!.meta.inputTokens).toBe(10);
      expect(span!.meta.outputTokens).toBe(5);
      expect(span!.meta.durationMs).toBe(200);
    });

    it('should merge spanMeta with base metadata', async () => {
      const run = createMockRun();
      const runner = new WorkflowRunner(trace, run);

      await runner.runStep(
        'step1',
        'mySpan',
        async () => ({ topic: 'biology' }),
        {
          spanMeta: (a) => ({ topic: a.topic }),
        }
      );

      const resultTrace = runner.success('done').trace;
      const span = resultTrace.spans.find((s) => s.node === 'mySpan');
      expect(span!.meta.topic).toBe('biology');
      expect(span!.meta.cached).toBe(false);
    });

    it('should pass durable option through to executeStep', async () => {
      const run = createMockRun();
      const runner = new WorkflowRunner(trace, run);

      await runner.runStep('step1', 'span1', async () => 'ok', { durable: false });

      expect(run.executeStep).toHaveBeenCalledWith(
        'step1',
        expect.any(Function),
        { durable: false }
      );
    });
  });

  describe('success', () => {
    it('should build WorkflowSuccess with correct fields', () => {
      const run = createMockRun();
      const runner = new WorkflowRunner(trace, run);

      const result = runner.success('Quiz generated!');

      expect(result.success).toBe(true);
      expect(result.response).toBe('Quiz generated!');
      expect(result.finalAction).toBe('ANSWER');
      expect(result.totalInputTokens).toBe(0);
      expect(result.totalOutputTokens).toBe(0);
      expect(result.trace.traceId).toBe(trace.traceId);
    });
  });

  describe('failure', () => {
    it('should build WorkflowFailure with user-facing response and technical errorMessage', () => {
      const run = createMockRun();
      const runner = new WorkflowRunner(trace, run);

      const result = runner.failure(
        'Something went wrong.',
        'generation_failed',
        'LLM returned null response'
      );

      expect(result.success).toBe(false);
      expect(result.response).toBe('Something went wrong.');
      expect(result.finalAction).toBe('CLARIFY');
      expect(result.errorType).toBe('generation_failed');
      expect(result.errorMessage).toBe('LLM returned null response');
    });

    it('should default errorMessage to response when not provided', () => {
      const run = createMockRun();
      const runner = new WorkflowRunner(trace, run);

      const result = runner.failure('Try again.', 'some_error');

      expect(result.errorMessage).toBe('Try again.');
    });

    it('should include accumulated tokens in failure result', async () => {
      const run = createMockRun();
      const runner = new WorkflowRunner(trace, run);

      await runner.runStep('step1', 'span1', async () => ({
        usage: { inputTokens: 100, outputTokens: 50 },
        durationMs: 200,
      }));

      const result = runner.failure('Failed after step1', 'some_error');
      expect(result.totalInputTokens).toBe(100);
      expect(result.totalOutputTokens).toBe(50);
    });
  });

  describe('execute', () => {
    it('should return the body result on success', async () => {
      const run = createMockRun();
      const runner = new WorkflowRunner(trace, run);

      const result = await runner.execute(
        async () => runner.success('OK'),
        []
      );

      expect(result.success).toBe(true);
      expect(result.response).toBe('OK');
    });

    it('should map WorkflowStepError to failure via error table', async () => {
      const run = createMockRun();
      const runner = new WorkflowRunner(trace, run);

      const errorMap: ErrorMapping[] = [
        { code: 'MY_ERROR', message: 'User-facing message', errorType: 'my_error' },
      ];

      const result = await runner.execute(async () => {
        throw new WorkflowStepError('MY_ERROR', 'Technical: thing broke');
      }, errorMap);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.response).toBe('User-facing message');
        expect(result.errorType).toBe('my_error');
        expect(result.errorMessage).toBe('Technical: thing broke');
      }
    });

    it('should call onError callback when error code matches', async () => {
      const run = createMockRun();
      const runner = new WorkflowRunner(trace, run);
      const onError = vi.fn();

      const errorMap: ErrorMapping[] = [
        { code: 'MY_ERROR', message: 'Oops', errorType: 'my_error', onError },
      ];

      const stepError = new WorkflowStepError('MY_ERROR', 'broke', { detail: 'extra' });

      await runner.execute(async () => {
        throw stepError;
      }, errorMap);

      expect(onError).toHaveBeenCalledWith(stepError);
      expect(onError).toHaveBeenCalledTimes(1);
    });

    it('should pass error details through onError callback', async () => {
      const run = createMockRun();
      const runner = new WorkflowRunner(trace, run);
      let capturedDetails: Record<string, unknown> = {};

      const errorMap: ErrorMapping[] = [
        {
          code: 'VALIDATION_FAILED',
          message: 'Bad quiz',
          errorType: 'validation_failed',
          onError: (err) => {
            capturedDetails = err.details;
          },
        },
      ];

      await runner.execute(async () => {
        throw new WorkflowStepError('VALIDATION_FAILED', 'validation broke', {
          validationErrors: ['missing answer', 'empty question'],
        });
      }, errorMap);

      expect(capturedDetails.validationErrors).toEqual(['missing answer', 'empty question']);
    });

    it('should return generic failure for unmatched WorkflowStepError', async () => {
      const run = createMockRun();
      const runner = new WorkflowRunner(trace, run);

      const result = await runner.execute(async () => {
        throw new WorkflowStepError('UNKNOWN_CODE', 'something weird');
      }, []);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errorType).toBe('UNKNOWN_CODE');
        expect(result.errorMessage).toBe('something weird');
      }
    });

    it('should return generic failure for non-WorkflowStepError', async () => {
      const run = createMockRun();
      const runner = new WorkflowRunner(trace, run);

      const result = await runner.execute(async () => {
        throw new Error('Redis connection failed');
      }, []);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errorType).toBe('unhandled_tool_error');
        expect(result.errorMessage).toBe('Redis connection failed');
        expect(result.response).toBe('Something went wrong. Please try again.');
      }
    });

    it('should preserve accumulated tokens in error-mapped failures', async () => {
      const run = createMockRun();
      const runner = new WorkflowRunner(trace, run);

      // Accumulate some tokens before failure
      await runner.runStep('step1', 'span1', async () => ({
        usage: { inputTokens: 100, outputTokens: 50 },
        durationMs: 200,
      }));

      const errorMap: ErrorMapping[] = [
        { code: 'STEP2_FAILED', message: 'Step 2 broke', errorType: 'step2_failed' },
      ];

      const result = await runner.execute(async () => {
        throw new WorkflowStepError('STEP2_FAILED', 'technical detail');
      }, errorMap);

      expect(result.success).toBe(false);
      expect(result.totalInputTokens).toBe(100);
      expect(result.totalOutputTokens).toBe(50);
    });
  });

  describe('hasUsage (duck typing)', () => {
    it('should detect artifacts with usage and durationMs', async () => {
      const run = createMockRun();
      const runner = new WorkflowRunner(trace, run);

      await runner.runStep('step1', 'span1', async () => ({
        usage: { inputTokens: 10, outputTokens: 5 },
        durationMs: 100,
        extraField: 'ignored',
      }));

      expect(runner.success('ok').totalInputTokens).toBe(10);
    });

    it('should not match artifacts missing usage', async () => {
      const run = createMockRun();
      const runner = new WorkflowRunner(trace, run);

      await runner.runStep('step1', 'span1', async () => ({
        durationMs: 100,
      }));

      expect(runner.success('ok').totalInputTokens).toBe(0);
    });

    it('should not match artifacts missing durationMs', async () => {
      const run = createMockRun();
      const runner = new WorkflowRunner(trace, run);

      await runner.runStep('step1', 'span1', async () => ({
        usage: { inputTokens: 10, outputTokens: 5 },
      }));

      expect(runner.success('ok').totalInputTokens).toBe(0);
    });

    it('should not match null or primitive artifacts', async () => {
      const run = createMockRun();
      const runner = new WorkflowRunner(trace, run);

      await runner.runStep('step1', 'span1', async () => 'just a string');
      await runner.runStep('step2', 'span2', async () => 42);

      expect(runner.success('ok').totalInputTokens).toBe(0);
    });
  });
});
