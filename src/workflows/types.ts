import type { RerankedChunk, Memory, AgentTrace, DocumentChunk } from '../schemas/types';
import type { WorkflowRun } from './WorkflowRun';

export interface WorkflowContext {
  userQuery: string;
  contextBlock: string | null;
  documents: RerankedChunk[];
  memories: Memory[];
  trace: AgentTrace;
  sessionId: string;
  conversationContext: string | null;
  retrieve: (query: string) => Promise<DocumentChunk[]>;
}

interface WorkflowResultBase {
  response: string;
  trace: AgentTrace;
  totalInputTokens: number;
  totalOutputTokens: number;
  data?: unknown;
}

export interface WorkflowSuccess extends WorkflowResultBase {
  success: true;
  finalAction: 'ANSWER';
}

export interface WorkflowFailure extends WorkflowResultBase {
  success: false;
  finalAction: 'CLARIFY';
  errorType: string;
  errorMessage: string;
}

export type WorkflowResult = WorkflowSuccess | WorkflowFailure;

export interface WorkflowTool {
  name: string;
  description: string;
  keywords: RegExp[];
  execute: (ctx: WorkflowContext, run: WorkflowRun) => Promise<WorkflowResult>;
}

export interface RouteResult {
  tool: WorkflowTool;
  method: 'deterministic';
}
