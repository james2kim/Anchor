import type { z } from 'zod/v4';
import type { WorkflowRunRecord, StepRecord } from './durableTypes';
import type { WorkflowRunStoreClass } from '../stores/WorkflowRunStore';
import { withTimeout } from '../util/RetryUtil';
import { wlog } from '../util/WorkflowLogger';

const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

export interface StepResult<T> {
  artifact: T;
  cached: boolean;
}

export interface StepOptions<T> {
  /** If false, skip the "mark running" write — use for cheap deterministic steps. Default: true */
  durable?: boolean;
  /** Optional Zod schema to validate cached artifacts on resume. Re-executes if validation fails. */
  schema?: z.ZodType<T>;
  /** Step-level timeout in ms. Wraps the entire step (including retries) with withTimeout. */
  timeoutMs?: number;
}

export class WorkflowRun {
  private record: WorkflowRunRecord;
  private store: WorkflowRunStoreClass;

  constructor(record: WorkflowRunRecord, store: WorkflowRunStoreClass) {
    this.record = record;
    this.store = store;
  }

  get runId(): string {
    return this.record.runId;
  }

  get status(): WorkflowRunRecord['status'] {
    return this.record.status;
  }

  getStep(name: string): StepRecord | undefined {
    return this.record.steps[name];
  }

  private async save(): Promise<void> {
    this.record.updatedAt = new Date().toISOString();
    await this.store.saveRun(this.record);
  }

  async executeStep<T>(
    name: string,
    fn: () => Promise<T>,
    opts?: StepOptions<T>
  ): Promise<StepResult<T>> {
    const durable = opts?.durable !== false;
    const existing = this.record.steps[name];

    // Completed → return cached artifact (with optional schema validation)
    if (existing?.status === 'completed') {
      if (opts?.schema) {
        const result = opts.schema.safeParse(existing.artifact);
        if (!result.success) {
          wlog.warn(
            `[WorkflowRun] Cached artifact for "${name}" failed schema validation, re-executing`
          );
          // Fall through to re-execute
        } else {
          wlog.log(`[WorkflowRun] Step "${name}" already completed, returning cached artifact`);
          return { artifact: result.data as T, cached: true };
        }
      } else {
        wlog.log(`[WorkflowRun] Step "${name}" already completed, returning cached artifact`);
        return { artifact: existing.artifact as T, cached: true };
      }
    }

    // Running + fresh → safety guard against dual-execution
    if (existing?.status === 'running' && existing.startedAt) {
      const elapsed = Date.now() - new Date(existing.startedAt).getTime();
      if (elapsed < STALE_THRESHOLD_MS) {
        throw new Error(
          `Step "${name}" is already running (started ${Math.round(elapsed / 1000)}s ago). ` +
            'Possible dual-execution detected.'
        );
      }
      // Running + stale → treat as crashed, re-execute below
      wlog.log(`[WorkflowRun] Step "${name}" is stale (${Math.round(elapsed / 1000)}s), re-executing`);
    }

    // Mark running and persist (skip for non-durable steps)
    const step: StepRecord = {
      name,
      status: 'running',
      startedAt: new Date().toISOString(),
      completedAt: null,
      artifact: null,
      error: null,
    };
    this.record.steps[name] = step;
    if (durable) {
      await this.save();
    }

    // Execute fn — distinguish fn() failures from save() failures
    let artifact: T;
    try {
      artifact = opts?.timeoutMs ? await withTimeout(fn, opts.timeoutMs) : await fn();
    } catch (fnErr) {
      // fn() itself failed — mark step as failed and persist
      step.status = 'failed';
      step.completedAt = new Date().toISOString();
      step.error = fnErr instanceof Error ? fnErr.message : String(fnErr);
      try {
        await this.save();
      } catch (saveErr) {
        wlog.error(`[WorkflowRun] Failed to persist step "${name}" failure:`, saveErr);
      }
      throw fnErr;
    }

    // fn() succeeded — persist completion (don't overwrite to 'failed' if save fails)
    step.status = 'completed';
    step.completedAt = new Date().toISOString();
    step.artifact = artifact;
    try {
      await this.save();
    } catch (saveErr) {
      wlog.error(
        `[WorkflowRun] Step "${name}" completed but failed to persist (will re-execute on resume):`,
        saveErr
      );
      // Don't throw — the artifact is valid, let the workflow continue
    }

    return { artifact, cached: false };
  }

  async complete(): Promise<void> {
    this.record.status = 'completed';
    await this.save();
    await this.store.clearActiveRun(this.record.sessionId);
  }

  async fail(error: string): Promise<void> {
    this.record.status = 'failed';
    this.record.error = error;
    await this.save();
    await this.store.clearActiveRun(this.record.sessionId);
  }
}
