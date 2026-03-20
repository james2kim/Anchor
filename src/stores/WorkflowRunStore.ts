import crypto from 'crypto';
import type { RedisClientType } from 'redis';
import { RedisSessionStore, RedisSessionStoreClass } from './RedisSessionStore';
import type { WorkflowRunRecord } from '../workflows/durableTypes';
import { workflowRunRecordSchema } from '../workflows/durableTypes';
import { wlog } from '../util/WorkflowLogger';

const KEY_PREFIX = 'wfrun:';
const TTL_SECONDS = 604800; // 1 week
const LOCK_PREFIX = 'wflock:';
const LOCK_TTL_SECONDS = 120; // 2 minutes — auto-release if process crashes

export class WorkflowRunStoreClass {
  private client: RedisClientType;
  private activeLocks = new Map<string, string>(); // sessionId → lockId

  constructor(store: RedisSessionStoreClass) {
    this.client = store.getClient();
  }

  private activeKey(sessionId: string): string {
    return `${KEY_PREFIX}${sessionId}:active`;
  }

  private runKey(runId: string): string {
    return `${KEY_PREFIX}${runId}`;
  }

  async getRun(runId: string): Promise<WorkflowRunRecord | null> {
    const raw = await this.client.get(this.runKey(runId));
    if (!raw) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      wlog.error(`[WorkflowRunStore] Failed to parse JSON for run ${runId}`);
      return null;
    }

    const result = workflowRunRecordSchema.safeParse(parsed);
    if (!result.success) {
      wlog.error(
        `[WorkflowRunStore] Schema validation failed for run ${runId}:`,
        result.error.issues.map((i) => i.message)
      );
      return null;
    }

    return result.data as WorkflowRunRecord;
  }

  async saveRun(record: WorkflowRunRecord): Promise<void> {
    await this.client.set(this.runKey(record.runId), JSON.stringify(record), {
      EX: TTL_SECONDS,
    });
  }

  async clearActiveRun(sessionId: string): Promise<void> {
    await this.client.del(this.activeKey(sessionId));
  }

  /**
   * Atomically get-or-create a workflow run using a Redis Lua script.
   * Falls back to the non-atomic path if Lua eval is unavailable.
   */
  async getOrCreateRun(
    sessionId: string,
    toolName: string
  ): Promise<{ record: WorkflowRunRecord; resumed: boolean }> {
    try {
      return await this.getOrCreateRunAtomic(sessionId, toolName);
    } catch (err) {
      wlog.error('[WorkflowRunStore] Lua eval failed, falling back to non-atomic path:', err);
      return this.getOrCreateRunFallback(sessionId, toolName);
    }
  }

  private async getOrCreateRunAtomic(
    sessionId: string,
    toolName: string
  ): Promise<{ record: WorkflowRunRecord; resumed: boolean }> {
    const newRecord = this.createRecord(sessionId, toolName);
    const activeKeyStr = this.activeKey(sessionId);

    // Lua script: atomically read active key, decide resume/supersede/create
    const luaScript = `
      local activeKey = KEYS[1]
      local ttl = tonumber(ARGV[1])
      local toolName = ARGV[2]
      local newRunJson = ARGV[3]
      local newRunId = ARGV[4]
      local keyPrefix = ARGV[5]

      local activeRunId = redis.call('GET', activeKey)

      if activeRunId then
        local runKey = keyPrefix .. activeRunId
        local existingJson = redis.call('GET', runKey)

        if existingJson then
          local existing = cjson.decode(existingJson)

          if existing.toolName == toolName and existing.status == 'running' then
            return cjson.encode({ action = 'resumed', record = existingJson })
          end

          if existing.status == 'running' then
            existing.status = 'failed'
            existing.error = 'superseded'
            existing.updatedAt = ARGV[6]
            redis.call('SET', runKey, cjson.encode(existing), 'EX', ttl)
          end
        end
      end

      local newRunKey = keyPrefix .. newRunId
      redis.call('SET', newRunKey, newRunJson, 'EX', ttl)
      redis.call('SET', activeKey, newRunId, 'EX', ttl)
      return cjson.encode({ action = 'created', record = newRunJson })
    `;

    const result = await this.client.eval(luaScript, {
      keys: [activeKeyStr],
      arguments: [
        String(TTL_SECONDS),
        toolName,
        JSON.stringify(newRecord),
        newRecord.runId,
        KEY_PREFIX,
        new Date().toISOString(),
      ],
    }) as string;

    const parsed = JSON.parse(result);
    const record = JSON.parse(parsed.record) as WorkflowRunRecord;

    // Validate schema
    const validated = workflowRunRecordSchema.safeParse(record);
    if (!validated.success) {
      throw new Error(`Lua result failed schema validation: ${validated.error.message}`);
    }

    return { record: validated.data as WorkflowRunRecord, resumed: parsed.action === 'resumed' };
  }

  private async getOrCreateRunFallback(
    sessionId: string,
    toolName: string
  ): Promise<{ record: WorkflowRunRecord; resumed: boolean }> {
    const activeRunId = await this.client.get(this.activeKey(sessionId));

    if (activeRunId) {
      const existing = await this.getRun(activeRunId);

      if (existing && existing.toolName === toolName && existing.status === 'running') {
        return { record: existing, resumed: true };
      }

      if (existing && existing.status === 'running') {
        existing.status = 'failed';
        existing.error = 'superseded';
        await this.saveRun(existing);
      }
    }

    const record = this.createRecord(sessionId, toolName);
    await this.saveRun(record);
    await this.client.set(this.activeKey(sessionId), record.runId, {
      EX: TTL_SECONDS,
    });

    return { record, resumed: false };
  }

  /**
   * Acquire a session-scoped mutex. Returns a lockId on success, null if already held.
   * The lock auto-expires after LOCK_TTL_SECONDS to prevent deadlocks on crash.
   */
  async acquireSessionLock(sessionId: string): Promise<string | null> {
    const lockKey = `${LOCK_PREFIX}${sessionId}`;
    const lockId = crypto.randomUUID();
    const acquired = await this.client.set(lockKey, lockId, {
      NX: true,
      EX: LOCK_TTL_SECONDS,
    });
    if (acquired) {
      this.activeLocks.set(sessionId, lockId);
    }
    return acquired ? lockId : null;
  }

  /**
   * Release a session-scoped mutex. Only releases if the lockId matches (owner check).
   */
  async releaseSessionLock(sessionId: string, lockId: string): Promise<void> {
    const lockKey = `${LOCK_PREFIX}${sessionId}`;
    // Atomic check-and-delete via Lua to avoid releasing someone else's lock
    const script = `
      if redis.call('GET', KEYS[1]) == ARGV[1] then
        return redis.call('DEL', KEYS[1])
      end
      return 0
    `;
    await this.client.eval(script, { keys: [lockKey], arguments: [lockId] });
    this.activeLocks.delete(sessionId);
  }

  /**
   * Release all locks held by this process. Called during graceful shutdown.
   */
  async releaseAllActiveLocks(): Promise<void> {
    const entries = [...this.activeLocks.entries()];
    if (entries.length === 0) return;

    console.log(`[WorkflowRunStore] Releasing ${entries.length} active lock(s) for shutdown...`);
    await Promise.allSettled(
      entries.map(([sessionId, lockId]) => this.releaseSessionLock(sessionId, lockId))
    );
  }

  private createRecord(sessionId: string, toolName: string): WorkflowRunRecord {
    const now = new Date().toISOString();
    return {
      schemaVersion: 1,
      runId: crypto.randomUUID(),
      sessionId,
      toolName,
      status: 'running',
      steps: {},
      createdAt: now,
      updatedAt: now,
      error: null,
    };
  }
}

export const WorkflowRunStore = new WorkflowRunStoreClass(RedisSessionStore);
