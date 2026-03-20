import { AsyncLocalStorage } from 'node:async_hooks';

interface WorkflowLogContext {
  sessionId: string;
  runId?: string;
  toolName?: string;
}

const store = new AsyncLocalStorage<WorkflowLogContext>();

export function withWorkflowContext<T>(ctx: WorkflowLogContext, fn: () => Promise<T>): Promise<T> {
  return store.run(ctx, fn);
}

export function setWorkflowRunId(runId: string): void {
  const ctx = store.getStore();
  if (ctx) ctx.runId = runId;
}

export function setWorkflowToolName(toolName: string): void {
  const ctx = store.getStore();
  if (ctx) ctx.toolName = toolName;
}

function prefix(): string {
  const ctx = store.getStore();
  if (!ctx) return '';
  const parts = [`sid=${ctx.sessionId.slice(0, 8)}`];
  if (ctx.runId) parts.push(`rid=${ctx.runId.slice(0, 8)}`);
  if (ctx.toolName) parts.push(`tool=${ctx.toolName}`);
  return `[${parts.join(' ')}] `;
}

export const wlog = {
  log: (msg: string, ...args: unknown[]) => console.log(`${prefix()}${msg}`, ...args),
  warn: (msg: string, ...args: unknown[]) => console.warn(`${prefix()}${msg}`, ...args),
  error: (msg: string, ...args: unknown[]) => console.error(`${prefix()}${msg}`, ...args),
};
