import { z } from 'zod/v4';

export type StepStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface StepRecord {
  name: string;
  status: StepStatus;
  startedAt: string | null;
  completedAt: string | null;
  artifact: unknown | null;
  error: string | null;
}

export type WorkflowRunStatus = 'running' | 'completed' | 'failed';

export interface WorkflowRunRecord {
  schemaVersion: number;
  runId: string;
  sessionId: string;
  toolName: string;
  status: WorkflowRunStatus;
  steps: Record<string, StepRecord>;
  createdAt: string;
  updatedAt: string;
  error: string | null;
}

const stepRecordSchema = z.object({
  name: z.string(),
  status: z.enum(['pending', 'running', 'completed', 'failed']),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  artifact: z.unknown().nullable(),
  error: z.string().nullable(),
});

export const workflowRunRecordSchema = z.object({
  schemaVersion: z.number(),
  runId: z.string(),
  sessionId: z.string(),
  toolName: z.string(),
  status: z.enum(['running', 'completed', 'failed']),
  steps: z.record(z.string(), stepRecordSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
  error: z.string().nullable(),
});
