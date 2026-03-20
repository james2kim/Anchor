import { z } from 'zod/v4';
import { StateSchema, MessagesValue } from '@langchain/langgraph';

// ============================================================================
// SCHEMAS
// ============================================================================

// --- Primitives ---
export const isoDateString = z.string().refine((v) => !Number.isNaN(Date.parse(v)), {
  message: 'Invalid ISO date string',
});

// --- User Schemas ---
export const userSchema = z.object({
  id: z.uuid(),
  email: z.string().email(),
  password_hash: z.string().nullable(),
  name: z.string().nullable(),
  created_at: z.union([isoDateString, z.date()]),
  updated_at: z.union([isoDateString, z.date()]),
});

export const createUserSchema = z.object({
  email: z.string().email(),
  password_hash: z.string().optional(),
  name: z.string().optional(),
});

// --- Memory Schemas ---
export const memoryExtractionSchema = z.object({
  worth_keeping: z.boolean(),
  type: z.enum(['preference', 'goal', 'fact', 'decision', 'summary']),
  confidence: z.number().min(0).max(1),
  content: z.string().min(10).max(1000),
});

export const memoryExtractionArraySchema = z.object({
  memories: z.array(memoryExtractionSchema),
});

export const memorySchema = z.object({
  id: z.uuid(),
  user_id: z.string(),
  type: z.enum(['preference', 'goal', 'fact', 'decision', 'summary']),
  confidence: z.number().min(0).max(1),
  content: z.string().min(10).max(1000),
  created_at: z.union([isoDateString, z.date()]),
});

export const searchMemoriesInputSchema = z.object({
  queryText: z.string(),
  options: z.object({
    maxResults: z.number().max(20).default(5),
    maxTokens: z.number().max(2000),
    minConfidence: z.number().min(0.1).max(1).default(0.5),
    allowedTypes: z.array(z.enum(['preference', 'goal', 'fact', 'decision', 'summary'])).optional(),
  }),
});

export const searchMemoriesSuccessSchema = z.object({
  success: z.literal(true),
  memories: z.array(memorySchema),
  queryText: z.string(),
  user_id: z.string(),
  options: z.object({
    maxResults: z.number().max(20),
    maxTokens: z.number().max(2000),
    minConfidence: z.number().min(0.1).max(1),
    allowedTypes: z.array(z.enum(['preference', 'goal', 'fact', 'decision', 'summary'])).optional(),
  }),
  count: z.number().int().min(0),
});

export const searchMemoriesFailureSchema = z.object({
  success: z.literal(false),
  queryText: z.string(),
  user_id: z.string(),
  options: z
    .object({
      maxResults: z.number().max(20).optional(),
      maxTokens: z.number().max(2000).optional(),
      minConfidence: z.number().min(0).max(1).optional(),
      allowedTypes: z
        .array(z.enum(['preference', 'goal', 'fact', 'decision', 'summary']))
        .optional(),
    })
    .partial(),
  error_type: z.enum([
    'unknown_runtime_error',
    'invalid_input',
    'invalid_schema',
    'failed_sql_query',
    'not_found',
    'embedding_error',
  ]),
  error_message: z.string().min(10).max(500),
});

// --- Document/Chunk Schemas ---
export const rawChunkSchema = z.object({
  chunk_index: z.number(),
  content: z.string(),
  token_count: z.number(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const retrievedChunkSchema = rawChunkSchema.extend({
  id: z.string(),
  document_id: z.string(),
  document_title: z.string().optional(),
  document_source: z.string().optional(),
  created_at: z.string(),
  embedding: z.array(z.number()),
  distance: z.number(),
});

export const documentChunkSchema = retrievedChunkSchema.extend({
  confidence: z.number().min(0).max(1),
});

export const rerankedChunkSchema = documentChunkSchema.extend({
  relevance: z.number().min(1).max(10),
});

export const searchDocumentsInputSchema = z.object({
  queryText: z.string().describe('The search query to find relevant document chunks'),
  options: z
    .object({
      topK: z.number().min(1).max(20).default(5).describe('Number of chunks to return'),
    })
    .optional(),
});

export const searchDocumentsSuccessSchema = z.object({
  success: z.literal(true),
  chunks: z.array(documentChunkSchema),
  queryText: z.string(),
  count: z.number(),
});

export const searchDocumentsFailureSchema = z.object({
  success: z.literal(false),
  queryText: z.string(),
  error_type: z.enum(['embedding_error', 'query_error', 'no_results']),
  error_message: z.string(),
});

export const IngestDocumentSchema = z.object({
  source: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  title: z.string(),
  text: z.string(),
});

// --- Retrieval Gate Schemas ---
export const retrievalGateAssessmentSchema = z.object({
  queryType: z.enum([
    'study_content',
    'personal',
    'general_knowledge',
    'conversational',
    'off_topic',
    'unclear',
    'workflow',
  ]),
  referencesPersonalContext: z.boolean(),
  reasoning: z.string(),
});

export const retrievalGateDecisionSchema = z.object({
  shouldRetrieveDocuments: z.boolean().describe('Whether to search the document corpus'),
  shouldRetrieveMemories: z.boolean().describe('Whether to search long-term memories'),
  memoryBudget: z
    .enum(['full', 'minimal'])
    .default('full')
    .describe('Memory retrieval budget: full (6 memories) or minimal (2 memories)'),
  needsClarification: z
    .boolean()
    .describe('Whether the query is too ambiguous and needs clarification'),
  needsWorkflow: z
    .boolean()
    .describe('Whether the query requires a workflow execution'),
  reasoning: z.string().max(500).describe('Brief explanation of the decision'),
});

export const retrievedContextSchema = z.object({
  documents: z.array(documentChunkSchema).default([]),
  memories: z.array(memorySchema).default([]),
  gateDecision: retrievalGateDecisionSchema.optional(),
});

// --- Knowledge Extraction Schemas ---
export const studyMaterialExtractionSchema = z.object({
  title: z.string().min(3).max(200).describe('A descriptive title for the study material'),
  content: z.string().min(20).describe('The study content to store'),
  subject: z.string().max(100).optional().describe('Subject area (e.g., Biology, History)'),
});

export const knowledgeExtractionSchema = z.object({
  contentType: z
    .enum(['study_material', 'personal_memory', 'ephemeral'])
    .describe(
      'study_material: factual content to learn/reference. personal_memory: user preferences/goals/decisions. ephemeral: conversational, not worth storing.'
    ),
  studyMaterial: studyMaterialExtractionSchema.optional(),
  memories: z.array(memoryExtractionSchema).optional(),
});

// --- Summarization Schema ---
export const summarizationSchema = z.object({
  confidence: z.number().min(0).max(1),
  content: z.string().min(50).max(2500),
});

// --- Agent Trace Schemas ---
export const traceSpanSchema = z.object({
  node: z.string(),
  startTime: z.number(),
  durationMs: z.number(),
  meta: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
});

export const traceOutcomeSchema = z.object({
  status: z.enum(['success', 'refused', 'clarified', 'error']),
  reason: z.string().optional(),
  triggeringSpan: z.string().optional(),
  durationMs: z.number(),
});

export const agentTraceSchema = z.object({
  traceId: z.string(),
  queryId: z.string(),
  query: z.string(),
  startTime: z.number(),
  spans: z.array(traceSpanSchema),
  outcome: traceOutcomeSchema.nullable(),
});

// --- Message Schema ---
export const MessageSchema = z.object({
  id: z.string(),
  role: z.string(),
  content: z.string(),
  createdAt: isoDateString,
});

// --- Session State Schema ---
export const SessionStateSchema = z.object({
  messages: z.array(MessageSchema),
  response: z.string().optional(),
  taskState: z.object({
    attempts: z.number(),
  }),
  updatedAt: isoDateString,
  summary: z.string().max(2500),
  sessionId: z.string(),
  userId: z.string(),
});

// --- Redis Options Schema ---
export const RedisOptionsSchema = z.object({
  redisUrl: z.string(),
  ttlSeconds: z.number(),
  maxMessages: z.number(),
  keyPrefix: z.string().optional(),
});

// --- Final Action Schema (for structured eval output) ---
export const finalActionSchema = z.enum(['ANSWER', 'REFUSE', 'CLARIFY', 'EXPAND_RETRIEVAL']);

// --- Trace Summary Schema (lightweight trace for evals) ---
export const traceSummarySchema = z.object({
  traceId: z.string(),
  queryType: z.string().optional(),
  outcome: z.string().optional(),
  durationMs: z.number().optional(),
  documentsRetrieved: z.number().optional(),
  memoriesRetrieved: z.number().optional(),
  didRetrieval: z.boolean().optional(),
});

// --- Agent State Schema ---
export const AgentStateSchema = new StateSchema({
  messages: MessagesValue,
  response: z.string().optional(),
  finalAction: finalActionSchema.optional(),
  traceSummary: traceSummarySchema.optional(),
  taskState: z.object({
    attempts: z.number(),
  }),
  updatedAt: isoDateString,
  summary: z.string().max(2500),
  userQuery: z.string(),
  sessionId: z.string(),
  userId: z.string(),
  gateDecision: retrievalGateDecisionSchema.optional(),
  queryEmbedding: z.array(z.number()).optional(),
  retrievedContext: z
    .object({
      documents: z.array(rerankedChunkSchema).default([]),
      memories: z.array(memorySchema).default([]),
    })
    .optional(),
  trace: agentTraceSchema.optional(),
  matchedWorkflowTool: z.string().optional(),
  workflowData: z.unknown().optional(),
});

// ============================================================================
// TYPES
// ============================================================================

// --- User Types ---
export type User = z.infer<typeof userSchema>;
export type CreateUser = z.infer<typeof createUserSchema>;

// --- Memory Types ---
export type MemoryExtraction = z.infer<typeof memoryExtractionSchema>;
export type MemoryExtractionArray = z.infer<typeof memoryExtractionArraySchema>;
export type Memory = z.infer<typeof memorySchema>;
export type SearchMemoriesInput = z.infer<typeof searchMemoriesInputSchema>;

// --- Document/Chunk Types ---
export type RawChunk = z.infer<typeof rawChunkSchema>;
export type RetrievedChunk = z.infer<typeof retrievedChunkSchema>;
export type DocumentChunk = z.infer<typeof documentChunkSchema>;
export type RerankedChunk = z.infer<typeof rerankedChunkSchema>;
export type SearchDocumentsInput = z.infer<typeof searchDocumentsInputSchema>;
export type IngestDocument = z.infer<typeof IngestDocumentSchema>;

// --- Retrieval Gate Types ---
export type RetrievalGateAssessment = z.infer<typeof retrievalGateAssessmentSchema>;
export type RetrievalGateDecision = z.infer<typeof retrievalGateDecisionSchema>;
export type RetrievedContext = z.infer<typeof retrievedContextSchema>;

// --- Knowledge Extraction Types ---
export type StudyMaterialExtraction = z.infer<typeof studyMaterialExtractionSchema>;
export type KnowledgeExtraction = z.infer<typeof knowledgeExtractionSchema>;

// --- Message Types ---
export type Message = z.infer<typeof MessageSchema>;

// --- Session/State Types ---
export type SessionState = z.infer<typeof SessionStateSchema>;
export type RedisOptions = z.infer<typeof RedisOptionsSchema>;
export type AgentState = typeof AgentStateSchema.State;

// --- Trace Types ---
export type TraceSpan = z.infer<typeof traceSpanSchema>;
export type TraceOutcome = z.infer<typeof traceOutcomeSchema>;
export type AgentTrace = z.infer<typeof agentTraceSchema>;
export type FinalAction = z.infer<typeof finalActionSchema>;
export type TraceSummary = z.infer<typeof traceSummarySchema>;
