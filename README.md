# Anchor

A conversational AI study assistant with persistent memory, document RAG, and intelligent retrieval. Built with LangGraph, React, PostgreSQL (pgvector), and Redis.

## Features

- **Persistent Memory** - Extracts and stores facts, goals, preferences, and decisions from conversations
- **Document RAG** - Upload and query documents with hybrid search (semantic + keyword + temporal)
- **Session Continuity** - Redis-backed sessions with automatic summary archival to long-term memory
- **Smart Retrieval** - Hybrid Rule-Based and LLM-powered retrieval gate that decides when to search documents vs. memories vs. neither
- **Workflow Tool Calling** - Extensible tool system with durable execution, keyword-based routing, and automatic resumption on failure
- **Quiz Generation** - Multi-step workflow tool that extracts intent, enriches context, generates quizzes, validates output, and persists results
- **React Web UI** - Mobile-responsive chat interface with document upload, quiz taking, and markdown rendering
- **User Authentication** - Clerk-based auth with automatic user provisioning and per-user data isolation
- **Large File Upload** - Files over 25 MB bypass Firebase limits via signed URL upload to GCS with BullMQ-based job queue processing
- **Job Queue** - BullMQ worker queue for file processing with automatic retries, progress tracking, stall detection, and graceful shutdown
- **Production Resilience** - Rate limiting, retry with exponential backoff on external APIs, and graceful fallback to keyword-only search when embeddings are unavailable

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                            User Query                                    │
└─────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         LangGraph Workflow                               │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │                       retrievalGate                                │  │
│  │  • Rewrite query (resolve pronouns via LLM extract + regex sub)   │  │
│  │  • Classify: rule-based (60-70%) or LLM fallback (Haiku)         │  │
│  │  • Pre-resolve workflow tool via keyword matching                  │  │
│  │  • Policy decides: retrieve? clarify? workflow?                   │  │
│  └───────────────────────────┬───────────────────────────────────────┘  │
│            ┌─────────────────┼─────────────────┐                        │
│            ▼                 ▼                  ▼                        │
│  ┌──────────────────┐  ┌──────────────┐  ┌───────────────────────────┐ │
│  │clarificationResp.│  │ injectContext │  │ retrieveMemoriesAndChunks │ │
│  │ (off-topic/      │  │ (no retrieval │  │  • Two-tier memory search  │ │
│  │  unclear)        │  │  needed)      │  │  • Hybrid doc search (RRF) │ │
│  └──────────────────┘  └──────────────┘  └─────────────┬─────────────┘ │
│                                           ┌────────────┴────────────┐   │
│                                           ▼                         ▼   │
│                              ┌─────────────────────┐  ┌──────────────┐ │
│                              │   executeWorkflow    │  │ injectContext │ │
│                              │  • Route to tool     │  │ • U-shape ctx │ │
│                              │  • Durable execution │  │ • Model route │ │
│                              │  • Session locking   │  │ • Generate    │ │
│                              └──────────┬──────────┘  └──────┬───────┘ │
│                                         │                     │         │
│                                         ▼                     ▼         │
│                              ┌─────────────────────────────────────┐    │
│                              │     extractAndStoreKnowledge        │    │
│                              │  • Extract facts/goals/prefs        │    │
│                              │  • Dedupe via cosine similarity     │    │
│                              │  • Summarize messages (background)  │    │
│                              └─────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────┘
         │                                        │
         ▼                                        ▼
┌─────────────────────┐              ┌─────────────────────────────┐
│    PostgreSQL       │              │           Redis             │
│   (Long-term)       │              │        (Short-term)         │
│                     │              │                             │
│  • memories (pgvec) │              │  • Session state            │
│  • documents        │              │  • Messages + summary       │
│  • chunks (hybrid)  │              │  • LangGraph checkpoints    │
│  • quizzes          │              │  • Workflow run state (1wk)  │
└─────────────────────┘              │  • Session locks             │
                                     └─────────────────────────────┘
```

## Memory Architecture

### Short-Term Memory (Redis)

Session-scoped memory with 24-hour TTL:

| Key Pattern                     | Purpose                                      |
| ------------------------------- | -------------------------------------------- |
| `session:<id>`                  | Session state (messages, summary, taskState) |
| `checkpoint:<thread_id>:latest` | LangGraph checkpoint for workflow resumption |
| `user:<id>:active_session`      | Maps user to their active session            |
| `wfrun:<runId>`                 | Durable workflow run record (1-week TTL)     |
| `wfrun:<sessionId>:active`      | Currently active workflow run for session    |
| `wflock:<sessionId>`            | Session-scoped workflow mutex (120s TTL)     |

**Stale Session Archival**: When a session is inactive for 12+ hours but accessed again, the session summary is persisted to long-term memory before continuing. This ensures important context survives session expiration.

### Long-Term Memory (PostgreSQL + pgvector)

Permanent storage for extracted knowledge and documents:

**memories table:**
| Field | Description |
|-------|-------------|
| `type` | fact, preference, goal, decision, summary |
| `content` | The extracted memory content |
| `confidence` | 0.0-1.0 extraction confidence |
| `embedding` | VoyageAI embedding (vector) for semantic search |
| `user_id` | Owner of the memory |

**documents table:**
| Field | Description |
|-------|-------------|
| `source` | File path or URL |
| `title` | Document title |
| `metadata` | JSON metadata |
| `user_id` | Owner |

**chunks table:**
| Field | Description |
|-------|-------------|
| `content` | Chunk text |
| `embedding` | vector for cosine similarity (HNSW indexed) |
| `search_vector` | tsvector for BM25 keyword search |
| `start_year` | Temporal range start (extracted) |
| `end_year` | Temporal range end (null = "Present") |
| `document_id` | Parent document |

**quizzes table:**
| Field | Description |
|-------|-------------|
| `title` | Quiz title (from generation) |
| `quiz_data` | JSON: full quiz with questions, options, answers, explanations |
| `input_data` | JSON: extracted intent (topic, difficulty, types) |
| `question_count` | Number of questions |
| `user_id` | Owner |

## Workflow Nodes

### 1. retrievalGate

Routes queries based on query rewriting + rule-based classification + LLM fallback + deterministic policy.

**Query Rewriting** (pronoun/reference resolution):
Resolves "it", "this", "that" and implicit references before classification:

1. LLM (Haiku) extracts the most recent topic from conversation context
2. Programmatic regex substitution replaces references with the extracted topic
3. No full-query LLM rewriting — avoids hallucination in the rewrite step

```
"quiz me on it" + context about mitosis → "quiz me on mitosis"
"explain"       + context about React   → "explain React"
```

**Rule-Based Classification** (instant, free):
Handles 60-70% of queries without LLM calls:

- Greetings/thanks → `conversational`
- Personal statements ("I am/like/prefer...") → `personal`
- Personal questions ("my goal", "what did I say") → `personal`
- Topic questions ("explain X", "what is Y") → `study_content`
- Lifestyle advice ("should I nap?") → `off_topic`
- Tool keywords (quiz, test, practice) → `workflow` (pre-resolves tool)

**LLM Assessment** (Haiku - for ambiguous cases):

- `queryType`: personal | study_content | general_knowledge | conversational | off_topic | unclear | workflow
- `referencesPersonalContext`: boolean

**Policy** (deterministic):

- `conversational` or `off_topic` → skip all retrieval
- `study_content` → search documents + memories (for personalization)
- `personal` → search documents + memories with full budget
- `workflow` → retrieve documents + memories, route to `executeWorkflow`
- `unclear` → request clarification

### 2. retrieveMemoriesAndChunks

Executes hybrid search based on gate decision.

**Two-Tier Memory Retrieval:**
Profile memories (preferences, facts) are always relevant for personalization but don't match well via semantic similarity (e.g., "give me a code example" won't semantically match "prefers TypeScript"). Solution:

1. **Tier 1 - Profile memories**: Fetch preferences + facts by confidence (no embedding needed)
2. **Tier 2 - Contextual memories**: Similarity search for goals, decisions, summaries

| Budget  | Profile | Contextual | Total |
| ------- | ------- | ---------- | ----- |
| Full    | 3       | 2          | 5     |
| Minimal | 2       | 0          | 2     |

**Hybrid Document Search Pipeline:**

1. Extract temporal year from query (e.g., "what did I do in 2023" → 2023)
2. Run in parallel:
   - **Embedding search**: pgvector cosine similarity with optional temporal filter
   - **Keyword search**: PostgreSQL tsvector/BM25 with same temporal filter
3. **RRF Fusion**: Combine results using Reciprocal Rank Fusion
   - `score = Σ(1 / (k + rank))` where k=60
4. Deduplicate and return top K chunks

### 3. injectContext

Builds the context block and generates the response.

**U-Shape Distribution** (based on "Lost in the Middle" research):

- LLMs attend most to beginning and end of context
- Most relevant items placed at front and back
- Least relevant items buried in the middle

```
Input (by relevance):  [1, 2, 3, 4, 5, 6]
Output (U-shape):      [1, 3, 5, 6, 4, 2]
```

**Context Format:**

```
## User Context
- [goal] Complete the study plan by Friday
- [preference] Prefers concise explanations

## Sources
[Source: Resume.pdf]
Software Engineer at Axiom, June 2022 – Present...

[Source: Biology Notes.md]
Cellular respiration is the process...
```

### 4. extractAndStoreKnowledge

Background extraction of knowledge from the conversation (runs async, doesn't block response).

**Knowledge Extraction:**

- Classifies input as `study_material`, `personal_memory`, or `ephemeral`
- Study material → ingested as document chunks with embeddings
- Personal memory → stored with type classification:
  - `preference`: User likes/prefers something (language, tools, learning style)
  - `fact`: Objective info (job, school, current projects)
  - `goal`: Future-oriented aspirations
  - `decision`: Past choices made
- Deduplicates against existing memories (cosine similarity ≥ 0.9)

**Message Summarization (Background):**
Prevents unbounded context growth while preserving important information.

| Trigger           | Action                             |
| ----------------- | ---------------------------------- |
| Messages reach 15 | Summarize oldest 10, keep newest 5 |
| Result            | Messages oscillate between 5-15    |

```
Before: [m1, m2, m3, m4, m5, m6, m7, m8, m9, m10, m11, m12, m13, m14, m15]
                    ↓ summarize oldest 10
After:  [summary] + [m11, m12, m13, m14, m15]
```

The summary is appended to the session's running summary, preserving context across pruning cycles.

### 5. executeWorkflow

Routes to and executes registered workflow tools (e.g., quiz generation).

**Tool Routing:**
The retrieval gate may pre-resolve the tool via keyword matching during classification. If not pre-resolved, `executeWorkflow` runs keyword scoring against all registered tools. This two-pass approach ensures tool routing is robust even when query rewriting changes the original phrasing.

```typescript
// Pre-resolved by gate (preferred — query-invariant)
const preResolved = state.matchedWorkflowTool ? getToolByName(state.matchedWorkflowTool) : null;
// Fallback: score keywords against rewritten query
const routeResult = preResolved ? { tool: preResolved } : routeToTool(userQuery);
```

**Session Locking:**
Prevents concurrent workflow execution within a session. A Redis-backed mutex (`SET NX EX 120s`) ensures only one workflow runs per session at a time. If a lock is held, the request is rejected with "A workflow is already running."

**In-Workflow Retrieval:**
Workflow tools receive a `ctx.retrieve(query)` function that allows them to fetch additional document chunks mid-execution. This is used when the initial retrieval context is thin (< 500 characters) — the tool can enrich its context without restarting the pipeline.

**Durable Execution:**
See [Durable Workflow Execution](#13-durable-workflow-execution) below.

### 6. clarificationResponse

Handles ambiguous queries by asking for clarification.

## Key Architecture Decisions

### 1. HNSW Vector Index

Similarity search on the `chunks.embedding` column uses an HNSW (Hierarchical Navigable Small World) index instead of sequential scan. HNSW builds a multi-layered graph over the vectors — top layers have sparse, long-range connections for coarse navigation, bottom layers have dense, short-range connections for precise lookup. Search traverses top-down in O(log n) hops rather than computing distance against every row (O(n)).

| Parameter         | Value                 | Effect                                                                  |
| ----------------- | --------------------- | ----------------------------------------------------------------------- |
| `m`               | 16                    | Max connections per node. Higher = better recall, more memory           |
| `ef_construction` | 64                    | Build-time candidate list. Higher = better graph quality, slower builds |
| `ef_search`       | 40 (pgvector default) | Query-time candidate list. Tunable per-query via `SET hnsw.ef_search`   |
| Operator class    | `vector_cosine_ops`   | Matches the `<=>` cosine distance operator used in queries              |

Tradeoff: ~99%+ recall vs exact search, which is negligible — chunking strategy and embedding quality are the actual retrieval bottlenecks.

### 2. Hybrid Search with Temporal Filtering

Pure semantic search misses queries like "what did I do in 2023" because embeddings don't capture temporal specificity well. The hybrid approach:

- **Embedding search**: Catches semantic meaning ("work experience" ≈ "job")
- **Keyword search**: Catches exact terms ("2023", "Axiom")
- **Temporal filter**: `start_year <= queryYear AND (end_year IS NULL OR end_year >= queryYear)`
- **RRF fusion**: Combines both rankings fairly

### 3. Retrieval Gate (Rule-Based + LLM Fallback)

Most queries can be classified without an LLM call:

- **Rule-based filter**: Regex patterns handle greetings, personal statements, topic questions (~60-70% of queries)
- **LLM fallback**: Haiku handles ambiguous cases that don't match patterns
- **Deterministic policy**: Code decides retrieval strategy based on classification

This reduces latency and cost while maintaining accuracy.

### 4. Two-Tier Memory Retrieval

Pure semantic similarity fails for personalization queries:

- "Give me a code example" doesn't semantically match "prefers TypeScript"
- But the TypeScript preference is essential for good code generation

Solution: separate profile retrieval from contextual retrieval:

- **Profile memories** (preferences, facts): Always fetched by confidence, no embedding needed
- **Contextual memories** (goals, decisions): Fetched by semantic similarity

This ensures user preferences are always available for generation tasks without relying on embedding similarity.

### 5. Off-Topic Handling

Off-topic queries (stock tips, medical advice) skip retrieval entirely and get a clean redirect: "I'm a study assistant—happy to help with learning or organizing your notes."

No mention of "I didn't find relevant documents" because that's confusing for genuinely off-topic questions.

### 6. Session Summary Persistence

When a session goes stale (12+ hours inactive), the accumulated session summary is stored as a long-term memory. This captures:

- Decisions made during the session
- Goals established
- Important context

Even after the Redis session expires, this knowledge persists.

### 7. U-Shape Context Distribution

Based on "Lost in the Middle" research showing LLMs attend poorly to middle content:

- Most relevant → front (high attention)
- Second most relevant → back (high attention)
- Least relevant → middle (low attention)

### 8. Adaptive Model Selection

The response generation step dynamically chooses between Haiku (fast/cheap) and Sonnet (capable/expensive) based on retrieval confidence:

| Scenario                                     | Model  | Rationale                                                   |
| -------------------------------------------- | ------ | ----------------------------------------------------------- |
| No context needed                            | Haiku  | Conversational queries don't need heavy reasoning           |
| Good retrieval (≥2 chunks, distance ≤0.6)    | Haiku  | Synthesizing from strong sources is straightforward         |
| Weak retrieval (few chunks or high distance) | Sonnet | Better at reasoning with sparse info, admitting uncertainty |

This reduces cost and latency for ~70% of queries while preserving quality for complex cases.

### 9. Document Title Citations

Sources cite document titles (e.g., `[Source: Resume.pdf]`) instead of opaque chunk indices, making responses more useful.

### 10. Production Resilience

Three layers protect against transient external API failures:

**Rate Limiting**: Express middleware limits each user to a fixed request rate on `/api/chat` and `/api/upload`, preventing abuse and runaway costs.

**Retry with Exponential Backoff**: All LLM (Anthropic) and embedding (VoyageAI) calls are wrapped in a generic `withRetry` utility. On transient failures (429, 5xx, network errors), requests retry up to 3 times with exponential backoff and jitter (~1s, ~2s, ~4s). Auth errors (401/403) and bad requests (400) fail immediately.

**Embedding Fallback**: If the embedding API fails even after retries, the retrieval pipeline degrades gracefully instead of returning empty results:

- Document search falls back to keyword-only (PostgreSQL full-text search)
- Profile memories (preferences, facts) are still retrieved (no embedding needed)
- Contextual memories (goals, decisions) are skipped since they require similarity search
- The `embeddingFallback` flag is captured in trace metadata for observability

### 11. Keyword-Based Tool Routing

Workflow tools are routed via deterministic keyword matching, not LLM-based function calling. Each tool registers an array of regex patterns:

```typescript
keywords: [
  /\b(quiz|test|assess)\s+me\b/i,
  /\bpractice\s+(test|questions|problems)\b/i,
  /\b(make|create|generate)\b.*\b(quiz|test|questions)\b/i,
]
```

Routing scores all tools by counting keyword matches and picks the highest. This is auditable (you can see exactly why a tool was selected), fast (no LLM call), and avoids hallucinated tool names. The tradeoff is manual keyword curation, but the tool surface is small enough that this is practical.

**Pre-Resolution:** The retrieval gate runs keyword matching during classification and stores the matched tool name in agent state. This means the tool is resolved against the *original* query before any rewriting, preventing cases where pronoun resolution strips away tool-triggering keywords.

### 12. Workflow Tool Abstraction

The workflow system uses a minimal interface that separates concerns:

```typescript
interface WorkflowTool {
  name: string;
  description: string;
  keywords: RegExp[];
  execute: (ctx: WorkflowContext, run: WorkflowRun) => Promise<WorkflowResult>;
}

interface WorkflowContext {
  userQuery: string;
  contextBlock: string | null;
  documents: RerankedChunk[];
  memories: Memory[];
  retrieve: (query: string) => Promise<DocumentChunk[]>;  // In-workflow retrieval
  // ...
}
```

Tools don't manage their own retrieval, routing, or persistence — they receive pre-fetched context and a durable run handle. This lets new tools be added by defining keywords + an `execute` function and registering in the tool registry. The `WorkflowRunner` handles token accumulation, error mapping, and observability for all tools uniformly.

### 13. Durable Workflow Execution

Workflows survive interruptions (server restarts, timeouts, client disconnects) via Redis-persisted step state:

```typescript
interface WorkflowRunRecord {
  runId: string;
  sessionId: string;
  toolName: string;
  status: 'running' | 'completed' | 'failed';
  steps: Record<string, StepRecord>;  // Each step cached independently
}

interface StepRecord {
  status: 'pending' | 'running' | 'completed' | 'failed';
  artifact: unknown | null;  // Cached result — skipped on resume
}
```

**Resumption logic:**
1. Step already completed → return cached artifact (skip re-execution)
2. Step marked running but stale (> 5 minutes) → re-execute (crash recovery)
3. Step marked running and fresh → reject (dual-execution prevention)
4. Step pending → execute normally

**Get-or-create with atomic Lua:** The `WorkflowRunStore` uses a Lua script to atomically check for an active run, supersede stale runs from different tools, or create a new run. This prevents race conditions between concurrent requests.

**Artifact validation:** Cached artifacts are optionally validated against Zod schemas on resume, catching cases where the schema evolved between the original execution and the resume.

Run records are stored with a 1-week TTL in Redis (`wfrun:{runId}`), with an active-run pointer (`wfrun:{sessionId}:active`) for fast lookup.

### 14. Workflow Error Mapping

Workflow tools use a catch-and-map pattern that separates internal errors from user-facing messages:

```typescript
const QUIZ_ERROR_MAP: ErrorMapping[] = [
  {
    code: 'INTENT_EXTRACTION_FAILED',
    message: "I couldn't understand what kind of quiz you'd like...",
    errorType: 'intent_extraction_failed',
    onError: (err) => validateObservation(err, failureSchema)  // Observability hook
  },
  {
    code: 'GENERATION_FAILED',
    message: "I had trouble generating the quiz...",
    errorType: 'generation_failed',
    onError: (err) => validateObservation(err, failureSchema)
  },
  {
    code: 'VALIDATION_FAILED',
    message: "The generated quiz didn't pass validation...",
    errorType: 'validation_failed',
    onError: (err) => validateObservation(err, failureSchema)
  },
]
```

Each step throws `WorkflowStepError` with a machine-readable code. The `WorkflowRunner.execute()` catches these and maps them to user-facing messages via the error table. Optional `onError` hooks validate failure observations against Zod schemas for eval integration.

### 15. Token Accounting

The `WorkflowRunner` auto-accumulates token usage across all steps:

```typescript
async runStep<T>(stepName, spanName, fn, opts?) {
  const result = await fn();
  // Auto-extract from step artifacts
  this.totalInputTokens += result.usage?.inputTokens ?? 0;
  this.totalOutputTokens += result.usage?.outputTokens ?? 0;
  return result;
}
```

`runner.success()` and `runner.failure()` attach the accumulated totals to the result, giving the trace layer a single place to read workflow-level token costs without each tool manually tracking usage.

### 16. Authentication with Clerk

Authentication is handled by Clerk, a managed auth service. This was chosen over building custom auth because:

- Not the focus of this project (learning agent architecture, not auth)
- Production-ready security out of the box
- Simple integration with React and Express

**Authentication Flow:**

1. User signs in via Clerk modal (supports email, OAuth providers)
2. Frontend passes JWT token with each API request via `Authorization: Bearer <token>`
3. Backend verifies token via `requireAuth()` middleware from `@clerk/express`
4. `getOrCreateUser()` finds or creates a user record in PostgreSQL linked to the Clerk ID
5. All data (memories, documents, sessions) is scoped to the authenticated user

## Quiz Generation Workflow

The quiz tool is the first workflow tool and demonstrates all the patterns of the tool calling system. It runs a 5-step durable pipeline:

```
User: "Quiz me on cellular respiration"
                │
                ▼
┌─────────────────────────────────────────────────────────────────┐
│  Step 1: Intent Extraction (Haiku)                              │
│  Extract: topic, questionCount, difficulty, questionTypes,      │
│           focusAreas from user query + conversation context     │
│  Timeout: 45s                                                    │
└───────────────────────────────┬─────────────────────────────────┘
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│  Step 2: Context Enrichment (conditional, non-durable)          │
│  If context < 500 chars → ctx.retrieve(topic) for more chunks  │
│  New chunks scored at 0.3 confidence (below reranked docs)     │
└───────────────────────────────┬─────────────────────────────────┘
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│  Step 3: Quiz Generation (Sonnet)                               │
│  Generate quiz with structured output (Zod schema)             │
│  Normalize true/false answers (handles LLM variations)         │
│  Timeout: 120s │ Durable: cached in Redis                      │
└───────────────────────────────┬─────────────────────────────────┘
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│  Step 4: Validation (deterministic, no LLM)                     │
│  • correctAnswer must appear in options                         │
│  • No duplicate options or questions                            │
│  • true_false: exactly 2 options ["True", "False"]             │
│  • multiple_choice: ≥ 3 options                                 │
└───────────────────────────────┬─────────────────────────────────┘
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│  Step 5: Format + Persist                                       │
│  • Render as markdown (questions + collapsible answer key)      │
│  • Return response + raw quiz data for DB persistence          │
│  • Auto-saved to PostgreSQL via /api/chat handler              │
└─────────────────────────────────────────────────────────────────┘
```

### Model Selection

| Step | Model | Rationale |
|------|-------|-----------|
| Intent extraction | Haiku | Fast structured output — extraction, not reasoning |
| Quiz generation | Sonnet | Complex reasoning for quality questions + consistency |

Both use `.withStructuredOutput(zodSchema, { includeRaw: true })` to get usage metadata alongside parsed output.

### Schemas

```typescript
// Input (extracted from user query)
quizInputSchema: {
  topic: string (2-200 chars),
  questionCount: int (1-20),
  questionTypes: ['multiple_choice' | 'true_false'],
  difficulty: 'easy' | 'medium' | 'hard',
  focusAreas?: string[] (max 5),
}

// Output (generated quiz)
quizOutputSchema: {
  title: string (5-200 chars),
  questions: [{
    type: 'multiple_choice' | 'true_false',
    question: string (10-500 chars),
    options: string[] (2-6 items),
    correctAnswer: string,
    explanation: string (10-500 chars),
  }] (1-20 items),
}
```

### True/False Normalization

LLMs produce inconsistent true/false answers ("true", "T", "correct", "Yes"). The `normalizeTrueFalse` function standardizes all variations to exactly `"True"` / `"False"` in both options and correctAnswer fields before validation runs. This is applied in-place after generation.

### Quiz Persistence

Quizzes are auto-saved when the `/api/chat` handler detects `workflowData` with a `title` and `questions` array in the response. The quiz ID is returned to the frontend for navigation.

```
/api/chat response → workflowData detected → QuizStore.save() → quizId in response
```

### Frontend Quiz Experience

The frontend provides an interactive quiz-taking UI:

- **QuizList**: Lists saved quizzes with title, question count, creation date, and delete with confirmation
- **QuizView**: Interactive quiz with option selection, submit scoring, correct/incorrect visual feedback, explanations, and retake

## File Upload Pipeline

File upload has three constraints in production: Firebase's **32 MB request body limit**, Firebase's **60-second request timeout**, and Voyage AI's **rate limit** on embedding calls. The upload pipeline addresses all three.

### Upload Routing — `uploadFileSmart`

The frontend decides which path to take based on file size and environment:

| Condition | Path | Why |
|-----------|------|-----|
| `file.size > 100 MB` | Reject | Hard cap |
| Local dev (any size) | Direct upload to `/api/upload` | No GCS credentials locally |
| Production, ≤ 25 MB | Direct upload to `/api/upload` | Fits within Firebase's 32 MB limit (with multipart overhead) |
| Production, > 25 MB | Signed URL → GCS → async processing | Bypasses Firebase entirely |

### Large File Path (> 25 MB in Production)

```
Browser                          Express Server                  BullMQ Worker              GCS           Voyage AI
   |                                |                                |                      |                |
   |-- POST /api/upload/signed-url ->|                                |                      |                |
   |   {filename, type, size}        |                                |                      |                |
   |                                 |-- generateSignedUploadUrl -----|--------------------->|                |
   |<-- {signedUrl, fileId, gcsPath} |                                |                      |                |
   |                                 |                                |                      |                |
   |-- PUT signedUrl (file bytes) ---|--------------(bypasses server)--|--------------------->| stored in GCS  |
   |   [XHR progress events → UI]    |                                |                      |                |
   |                                 |                                |                      |                |
   |-- POST /api/upload/process ---->|                                |                      |                |
   |   {fileId, gcsPath, filename}   |-- queue.add('process-file') -->|                      |                |
   |<-- {jobId, status: 'queued'}    |                                |                      |                |
   |                                 |                                |-- downloadAsBuffer ->|                |
   |   [UI unblocked — can chat]     |                                |<-- file buffer ------|                |
   |                                 |                                |-- extractText        |                |
   |                                 |                                |-- chunkText → N      |                |
   |                                 |                                |-- embedBatch --------|--------------->|
   |                                 |                                |<-- embeddings -------|----------------|
   |                                 |                                |   ... batches ...    |                |
   |                                 |                                |-- upsertChunks (DB)  |                |
   |                                 |                                |-- deleteFile ------->| cleaned up     |
   |                                 |                                |-- job.completed      |                |
   |                                 |                                |                      |                |
   |-- GET /api/upload/status/{id} ->|-- queue.getJob(id) ----------->|                      |                |
   |<-- {status:'completed', result} |                                |                      |                |
   |                                 |                                |                      |                |
   |   [UI: "Uploaded — N chunks ingested."]                          |                      |                |
```

### Step-by-Step Breakdown

**1. Signed URL Generation** (`POST /api/upload/signed-url` → `GcsUtil.generateSignedUploadUrl`)

The backend generates a V4 signed URL scoped to `uploads/{userId}/{fileId}/{filename}`. The URL is a pre-authenticated PUT endpoint on `storage.googleapis.com` that expires in 30 minutes. The userId in the path provides per-user isolation.

**2. Direct-to-GCS Upload** (`uploadToGcs` in `client.ts`)

The browser PUTs the file directly to the signed URL. This uses `XMLHttpRequest` instead of `fetch` because XHR supports `upload.progress` events — fetch does not. For a 50 MB file over a slow connection, the user sees a real progress bar.

Two infrastructure requirements:
- **GCS CORS** (`cors.json`): The bucket must allow PUT from the app's origins, otherwise the browser's preflight OPTIONS request fails
- **CSP header** (`helmet` config): `connectSrc` must include `https://storage.googleapis.com`, otherwise the Content Security Policy blocks the XHR

**3. BullMQ Job Queue** (`POST /api/upload/process`)

After the file lands in GCS, the frontend tells the backend to process it. The backend enqueues a job via BullMQ and returns immediately:
1. Adds a job to the `file-processing` queue with `jobId = fileId` (natural deduplication)
2. Returns `{ jobId, status: 'queued' }` immediately (< 100ms)
3. The in-process BullMQ worker picks up the job asynchronously

This is a unified path for both production and development — all uploads go through the queue. The UI is unblocked immediately after enqueue; the user can chat or upload more files while processing continues in the background.

Queue configuration:
- **Concurrency:** 2 jobs in parallel (allows overlap — one downloading while one embeds)
- **Retries:** 3 attempts with exponential backoff (10s base delay)
- **Lock duration:** 5 minutes (accommodates large files)
- **Retention:** Completed jobs kept 24 hours, failed jobs kept 7 days
- **Stall detection:** BullMQ automatically retries jobs if the worker crashes mid-processing

Security: the endpoint verifies `gcsPath.startsWith('uploads/{userId}/')` so users can't reference other users' files, and checks `fileExists` in GCS before processing.

**4. Progress Tracking & Polling** (`pollJobStatus` in `client.ts`)

The frontend polls `GET /api/upload/status/{jobId}` every 3 seconds. The status endpoint reads directly from BullMQ (not manual Redis keys) and includes progress stages reported by the worker:

| Poll Result | Action |
|-------------|--------|
| `status: 'queued'` | Continue polling (job waiting for worker) |
| `status: 'processing'` + `progress.stage` | Continue polling, update UI with stage (downloading, extracting text, embedding, cleaning up) |
| `status: 'completed'` | Return the result |
| `status: 'failed'` | Throw with error message |
| Auth redirect / non-API URL | Skip this poll, retry next (token may have expired) |
| 10-minute deadline exceeded | Throw "timed out" |

Auth resilience: Clerk tokens can expire during a long processing job. The polling loop catches `Session expired` errors and continues — `getToken` refreshes the token on the next iteration.

**5. File Processing** (`processGcsFile` in `src/ingest/processGcsFile.ts`)

The BullMQ worker calls `processGcsFile` with an `onProgress` callback that reports each stage back to the job:

1. Downloads the file from GCS into a Node.js Buffer → `progress: 'downloading'`
2. Extracts text using LangChain loaders (PDFLoader, DocxLoader, or raw UTF-8) → `progress: 'extracting_text'`
3. Extracts title from PDF metadata → content heuristics → cleaned filename
4. Calls `ingestDocument` (chunking + embedding + storage) → `progress: 'embedding'`
5. Deletes the file from GCS (data is in the database now) → `progress: 'cleaning_up'`

### Batched Embedding — `ingestDocument`

The old approach called `embedText()` once per chunk — 200 API calls for a 200-chunk document, which hit Voyage AI's rate limit and took 60+ seconds. The batched approach:

| Chunks | Batch Size | API Calls | Improvement |
|--------|-----------|-----------|-------------|
| 10 | 64 | 1 | 10x fewer |
| 200 | 64 | 4 (sizes: 64, 64, 64, 8) | 50x fewer |

Voyage AI supports up to 128 texts per batch call. We use 64 to stay under RPM limits with retries. A 500ms pause between batches provides additional rate limit headroom.

Each batch call is wrapped in `withRetry` with aggressive settings: 5 attempts, 2-second base delay, exponential backoff with jitter. The retry utility only retries transient errors (429, 5xx, network failures) — not auth or bad request errors.

### Safe Response Parsing — `safeFetchJson`

Every `fetch` call in the frontend parses responses through `safeFetchJson`, which handles the cases where Firebase/Cloud Run returns HTML instead of JSON:

| Response State | Result |
|----------------|--------|
| `response.redirected` or URL not `/api/` | Throws "Session expired" (Clerk auth redirect) |
| OK + valid JSON | Returns parsed data |
| OK + HTML body | Throws "Unexpected response from server" |
| Error (5xx) + JSON body | Returns parsed error (so frontend can show backend's message) |
| Error (5xx) + HTML body | Throws "Server error (502)" |

### Configuration

| Constant | Location | Value | Purpose |
|----------|----------|-------|---------|
| `LARGE_FILE_THRESHOLD` | `client.ts` | 25 MB | Files above this use the GCS path |
| `MAX_FILE_SIZE` | `client.ts` | 100 MB | Hard reject above this |
| `POLL_INTERVAL_MS` | `client.ts` | 3,000 ms | Polling frequency |
| `POLL_TIMEOUT_MS` | `client.ts` | 10 min | Max wait before "timed out" |
| `EMBED_BATCH_SIZE` | `ingestDocument.ts` | 64 | Texts per Voyage AI call |
| `BATCH_DELAY_MS` | `ingestDocument.ts` | 500 ms | Pause between batches |
| Queue concurrency | `workers.ts` | 2 | Parallel jobs per worker instance |
| Queue attempts | `queues.ts` | 3 | Max retries per job |
| Queue backoff | `queues.ts` | 10s exponential | Delay between retries |
| `removeOnComplete` | `queues.ts` | 24 hours | Completed job retention |
| `removeOnFail` | `queues.ts` | 7 days | Failed job retention |
| `lockDuration` | `workers.ts` | 5 min | Worker lock for large files |

## Scaling Roadmap

### Current Architecture

Chat requests are synchronous (Express → LLM → response). File processing is queued via BullMQ with an in-process worker. This is optimal for simplicity and latency at moderate scale.

**Already implemented:**
- **BullMQ job queue** for file upload processing — retries, progress tracking, stall detection, non-blocking UI
- **In-process worker** (concurrency 2) — runs alongside Express in the same Cloud Run instance

### Phase 1: Separate Worker Service

```
User → Express API (Cloud Run)           Worker Service (Cloud Run)
              |                                    |
              |-- queue.add() --> Redis <-- worker.process()
              |                                    |-- download, extract, embed
```

Split the BullMQ worker into a dedicated Cloud Run service. The queue code is already architected for this — `src/queue/workers.ts` can run standalone. This lets you scale API instances and worker instances independently.

### Phase 2: Chat Queue + SSE

```
User → Express API → Push to Queue → Return "accepted" (50ms)
                          ↓
                    Worker → LLM call → DB query → Write result
                          ↓
                    Redis Pub/Sub → SSE push to client
```

Move chat requests through the queue when LLM latency becomes a throughput bottleneck. The heavy logic (`getFormattedAnswerToUserinput`) is already isolated and can be moved into a worker with minimal refactoring.

### Phase 3: Connection Pooling + Read Replicas

At high read volume, the database becomes the bottleneck:
- **PgBouncer** for connection pooling (reduce per-connection overhead)
- **Read replicas** for embedding search queries (separate read/write traffic)
- **Redis caching** for frequently accessed embeddings and user profiles

## Project Structure

```
├── frontend/                    # React frontend (Vite)
│   ├── src/
│   │   ├── components/
│   │   │   ├── DocumentList.tsx # Document management
│   │   │   ├── QuizList.tsx     # Quiz listing + delete
│   │   │   ├── QuizView.tsx     # Interactive quiz taking
│   │   │   └── ConfirmModal.tsx # Reusable confirmation dialog
│   │   ├── hooks/
│   │   │   ├── useChat.ts       # Chat state management
│   │   │   └── useQuizzes.ts    # Quiz CRUD operations
│   │   ├── api/
│   │   │   └── client.ts        # API client (chat, docs, quizzes)
│   │   ├── utils/               # Markdown formatting
│   │   └── App.tsx              # Main app component
│   ├── package.json
│   └── vite.config.ts           # Builds to public/
│
├── public/                      # Built frontend (served by Express)
│
└── src/
    ├── server.ts                # Express API server
    ├── config.ts                # User ID management
    │
    ├── agent/
    │   ├── graph.ts             # LangGraph workflow definition
    │   ├── routers.ts           # Conditional routing logic
    │   ├── constants.ts         # Models, limits, system prompt
    │   └── nodes/
    │       ├── retrievalGate.ts
    │       ├── retrieveMemoriesAndChunks.ts
    │       ├── executeWorkflow.ts   # Workflow tool execution
    │       ├── injectContext.ts
    │       ├── extractKnowledge.ts
    │       ├── clarificationResponse.ts
    │       └── summarize.ts
    │
    ├── workflows/
    │   ├── types.ts             # WorkflowTool, WorkflowContext interfaces
    │   ├── registry.ts          # Tool registration + keyword routing
    │   ├── WorkflowRunner.ts    # Step runner, token accounting, error mapping
    │   ├── WorkflowRun.ts       # Durable execution state machine
    │   ├── durableTypes.ts      # WorkflowRunRecord, StepRecord types
    │   └── tools/
    │       └── quizTool.ts      # Quiz generation workflow (5-step pipeline)
    │
    ├── stores/
    │   ├── DocumentStore.ts     # Hybrid search, chunk management
    │   ├── MemoryStore.ts       # Long-term memory operations
    │   ├── RedisSessionStore.ts # Session state management
    │   ├── UserStore.ts         # User CRUD operations
    │   ├── QuizStore.ts         # Quiz persistence (CRUD)
    │   └── WorkflowRunStore.ts  # Durable run state (Redis + Lua)
    │
    ├── memory/
    │   └── RedisCheckpointer.ts # LangGraph checkpoint persistence
    │
    ├── llm/
    │   ├── retrievalAssessor.ts # Query classification (7 types)
    │   ├── queryRewriter.ts     # Pronoun resolution (LLM extract + regex sub)
    │   ├── quizGenerator.ts     # Intent extraction + quiz generation
    │   ├── quizValidator.ts     # Deterministic quiz validation
    │   ├── quizFormatter.ts     # Markdown formatting + answer key
    │   ├── promptBuilder.ts     # Context block + system prompt
    │   ├── summarizeMessages.ts # Conversation summarization
    │   └── extractMemories.ts   # Knowledge extraction
    │
    ├── ingest/
    │   ├── ingestDocument.ts    # Document chunking + embedding
    │   └── processGcsFile.ts    # GCS download → text extraction → ingestion
    │
    ├── queue/
    │   ├── index.ts             # Queue lifecycle (init/shutdown) + exports
    │   ├── connection.ts        # ioredis connection config for BullMQ
    │   ├── jobTypes.ts          # TypeScript interfaces for job data/result/progress
    │   ├── queues.ts            # file-processing queue (lazy singleton)
    │   ├── workers.ts           # BullMQ worker (concurrency 2, progress reporting)
    │   └── statusHelper.ts      # BullMQ state → API response mapping
    │
    ├── schemas/
    │   ├── types.ts             # Zod schemas and TypeScript types
    │   └── quizSchemas.ts       # Quiz input/output Zod schemas
    │
    ├── evals/
    │   ├── dataset.ts           # Test cases with expected behaviors
    │   ├── evaluators.ts        # Scoring (behavior, routing, content)
    │   ├── runLocal.ts          # Local test runner
    │   ├── runExperiment.ts     # LangSmith experiment runner
    │   ├── seed.ts              # Fixture seeder
    │   └── fixtures/
    │       └── evalDocuments.ts  # Fake test documents
    │
    ├── services/
    │   └── EmbeddingService.ts  # VoyageAI embeddings
    │
    ├── util/
    │   ├── DocumentUtil.ts      # Text chunking
    │   ├── TemporalUtil.ts      # Date range extraction
    │   ├── EmbeddingUtil.ts     # Vector formatting
    │   ├── TraceUtil.ts         # Trace pruning + candidate summaries
    │   ├── GcsUtil.ts           # GCS signed URLs, download, delete
    │   └── RetryUtil.ts         # Retry with exponential backoff
    │
    └── db/
        ├── knex.ts              # Database connection
        └── migrations/          # PostgreSQL migrations
```

## Setup

### Prerequisites

- Node.js 18+
- PostgreSQL 15+ with pgvector extension
- Redis server

### Installation

```bash
# Install dependencies
npm install
npm run frontend:install

# Start Redis (macOS)
brew services start redis

# Start PostgreSQL (macOS)
brew services start postgresql

# Create database with pgvector
psql -c "CREATE DATABASE study_agent;"
psql -d study_agent -c "CREATE EXTENSION IF NOT EXISTS vector;"

# Create .env.local
cp .env.example .env.local
```

**Required environment variables (.env.local):**

```
ANTHROPIC_API_KEY=sk-ant-...
VOYAGE_API_KEY=pa-...
REDIS_URL=redis://localhost:6379
DATABASE_URL=postgresql://localhost:5432/study_agent

# Clerk Authentication (get keys from https://dashboard.clerk.com)
CLERK_PUBLISHABLE_KEY=pk_test_...
CLERK_SECRET_KEY=sk_test_...

# GCS Upload (production only — large file uploads bypass Firebase via signed URLs)
GCS_UPLOAD_BUCKET=your-bucket-name
# GCS credentials are provided via GOOGLE_APPLICATION_CREDENTIALS or Cloud Run's default service account
```

**Frontend environment variables (frontend/.env.local):**

```
VITE_CLERK_PUBLISHABLE_KEY=pk_test_...
```

### Database Migrations

```bash
# Run all migrations
npm run migrate

# Rollback if needed
npm run migrate:rollback
```

### Running

```bash
# Development (builds frontend + starts server with hot reload)
npm run dev

# Development with frontend hot reload (two servers, use port 5173)
npm run dev:watch

# Production
npm start
```

Then open `http://localhost:3000`

### Frontend Development

The frontend is a React app built with Vite. It builds to `public/` and is served by Express.

```bash
# Install frontend dependencies (first time)
npm run frontend:install

# Build frontend only
npm run frontend:build

# Run frontend dev server only (with API proxy to :3000)
npm run frontend
```

## API Endpoints

All endpoints require authentication via Clerk. Include the JWT token in the `Authorization` header:

```
Authorization: Bearer <clerk_jwt_token>
```

### POST /api/chat

Send a message and get a response. If the response triggers a workflow tool (e.g., quiz generation), `workflowData` and `quizId` are included.

```json
Request:  { "message": "What's in my biology notes?" }
Response: { "response": "Based on your notes...", "sessionId": "..." }

// Workflow response (quiz):
Request:  { "message": "Quiz me on cellular respiration" }
Response: { "response": "## Biology Quiz\n...", "sessionId": "...", "quizId": "uuid" }
```

### POST /api/upload

Upload a document for ingestion (direct path, files ≤ 25 MB).

```
Request:  FormData with file
Response: { "documentId": "...", "chunkCount": 15, "filename": "notes.pdf", "title": "Biology Notes" }
```

### POST /api/upload/signed-url

Generate a signed URL for direct-to-GCS upload (large files > 25 MB).

```json
Request:  { "filename": "textbook.pdf", "contentType": "application/pdf", "fileSize": 52428800 }
Response: { "signedUrl": "https://storage.googleapis.com/...", "fileId": "uuid", "gcsPath": "uploads/..." }
```

### POST /api/upload/process

Enqueue a GCS-uploaded file for processing via BullMQ. Returns immediately.

```json
Request:  { "fileId": "uuid", "gcsPath": "uploads/...", "filename": "textbook.pdf" }
Response: { "jobId": "uuid", "status": "queued" }
```

### GET /api/upload/status/:jobId

Poll for job status. Reads directly from BullMQ, includes progress stages.

```json
Response: { "status": "completed", "result": { "documentId": "...", "chunkCount": 142 } }
      or: { "status": "processing", "progress": { "stage": "embedding", "detail": "..." } }
      or: { "status": "queued" }
      or: { "status": "failed", "error": "Could not extract text..." }
```

### GET /api/quizzes

List all quizzes for the authenticated user.

```json
Response: { "quizzes": [{ "id": "...", "title": "...", "question_count": 5, "created_at": "..." }] }
```

### GET /api/quizzes/:id

Get a single quiz with full question data.

```json
Response: { "quiz": { "id": "...", "title": "...", "quiz_data": { "title": "...", "questions": [...] }, "input_data": {...}, "created_at": "..." } }
```

### DELETE /api/quizzes/:id

Delete a quiz. Returns success status.

```json
Response: { "success": true }
```

### GET /api/session

Get current session state.

```json
Response: { "sessionId": "...", "messages": [...], "summary": "..." }
```

## Inspecting State

### Redis

```bash
# List all keys
redis-cli KEYS "*"

# View session state
redis-cli GET "session:<id>" | python3 -m json.tool

# Monitor in real-time
redis-cli MONITOR
```

### PostgreSQL

```bash
# View memories
psql -d study_agent -c "SELECT id, type, confidence, substring(content, 1, 50) FROM memories;"

# View documents
psql -d study_agent -c "SELECT id, title, source FROM documents;"

# View chunks with temporal data
psql -d study_agent -c "SELECT chunk_index, start_year, end_year, substring(content, 1, 40) FROM chunks;"
```

## Configuration

| Constant               | Location               | Default | Description                                                  |
| ---------------------- | ---------------------- | ------- | ------------------------------------------------------------ |
| `MAX_MESSAGES`         | `constants.ts`         | 15      | Triggers summarization (oldest 10 summarized, newest 5 kept) |
| `STALE_HOURS`          | `RedisSessionStore.ts` | 12      | Hours before session summary archival                        |
| `TTL`                  | `RedisSessionStore.ts` | 86400   | Session expiration (24 hours)                                |
| `SIMILARITY_THRESHOLD` | `extractKnowledge.ts`  | 0.9     | Memory deduplication threshold                               |
| `RRF_K`                | `DocumentStore.ts`     | 60      | RRF fusion constant                                          |

## Supported File Types

- `.txt` - Plain text
- `.md` - Markdown
- `.pdf` - PDF documents
- `.docx` - Word documents

## Development

```bash
# Lint
npm run lint

# Format
npm run format

# Test
npm run test
```

## Retrieval Quality Evaluation

The retrieval pipeline is tested with a dedicated evaluation suite that measures ranking quality.

### Metrics

| Metric             | Description                                                       | Threshold |
| ------------------ | ----------------------------------------------------------------- | --------- |
| **MRR**            | Mean Reciprocal Rank — average of 1/rank of first relevant result | ≥ 0.65    |
| **Recall@5**       | Fraction of relevant docs appearing in top 5 results              | ≥ 0.65    |
| **Disambiguation** | Correct doc ranks above keyword-similar-but-wrong doc             | ≥ 0.70    |

### Test Categories

| Category       | What it tests                                                                                                  |
| -------------- | -------------------------------------------------------------------------------------------------------------- |
| Temporal       | Date range filtering ("what did I do in 2023")                                                                 |
| Semantic       | Meaning-based retrieval without exact keywords                                                                 |
| Keyword        | Direct term matching ("ClickHouse migration")                                                                  |
| Study content  | Document content retrieval                                                                                     |
| Disambiguation | Correct doc outranks keyword-similar doc (e.g., "axiom in math" ranks math notes above "Axiom" company resume) |
| Edge cases     | Typos, long queries, single-word queries                                                                       |

### Running Tests

```bash
# Seed test data (required once)
npm run test:seed

# Run retrieval evaluation
npm run test:retrieval
```

### Test Fixtures

Test documents and queries are defined in `src/__tests__/fixtures/testDocuments.ts`. Add new test cases as your corpus grows to catch regressions.

## Agent Tracing

The agent includes an internal tracing system that captures structured spans for each node in the workflow.

### Trace Structure

```typescript
interface AgentTrace {
  traceId: string;
  queryId: string;
  query: string;
  startTime: number;
  spans: TraceSpan[]; // Append-only, each node adds one
  outcome: TraceOutcome; // Set once at the end
}

interface TraceSpan {
  node: string; // 'retrievalGate', 'hybridSearch', etc.
  startTime: number;
  durationMs: number;
  meta: Record<string, string | number | boolean | null>;
}

interface TraceOutcome {
  status: 'success' | 'refused' | 'clarified' | 'error';
  reason?: string;
  triggeringSpan?: string;
  durationMs: number;
}
```

### What Each Node Captures

| Node                        | Metadata                                                                           |
| --------------------------- | ---------------------------------------------------------------------------------- |
| `retrievalGate`             | queryType, wasRewritten, shouldRetrieveDocuments, shouldRetrieveMemories           |
| `retrieveMemoriesAndChunks` | profileMemories, contextualMemories, chunksRetrieved (+ hybrid search diagnostics) |
| `injectContext`             | documentsUsed, memoriesUsed, contextTokens, responseLength                         |
| `extractAndStoreKnowledge`  | contentType, memoriesAdded, studyMaterialIngested                                  |
| `clarificationResponse`     | responseLength                                                                     |

### Retrieval Diagnostics

The `retrieveMemoriesAndChunks` node captures detailed pipeline diagnostics to pinpoint where retrieval quality degrades:

| Stage             | Metrics                                                                                           | What it tells you                                       |
| ----------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| **Hybrid Search** | `embeddingCandidates`, `keywordCandidates`, `fusionOverlap`, `fusedCount`, `topEmbeddingDistance` | How many chunks each search found, overlap between them |
| **Pipeline**      | `afterRelevanceFilter`, `afterDedup`, `afterBudget`                                               | Chunk counts after each filtering stage                 |
| **Quality**       | `topChunkDistance`, `scoreSpread`, `uniqueDocuments`                                              | Confidence signals for retrieval quality                |
| **Temporal**      | `temporalFilterApplied`, `queryYear`                                                              | Whether date filtering was used                         |

**Example trace for debugging:**

```
embeddingCandidates: 40  →  keywordCandidates: 12  →  fusedCount: 35
    ↓
afterRelevanceFilter: 28  →  afterDedup: 22  →  afterBudget: 8
```

**Interpreting the diagnostics:**

- High `embeddingCandidates` but low `afterRelevanceFilter` → relevance rules too strict
- High `afterDedup` but low `afterBudget` → budget constraints cutting relevant chunks
- Large `scoreSpread` → retrieved chunks have varying quality
- `fusionOverlap` near 0 → embedding and keyword searches found different results (query ambiguity)

### Design Principles

- **Append-only spans**: Each node pushes its span, never mutates previous spans
- **Single outcome**: Set once at the end of the workflow
- **Stored in session state**: Flows through AgentState → Redis, expires with session
- **LangSmith compatible**: Trace data can be attached to LangSmith span metadata

### Trace Pruning

Traces are for observability, not a secondary memory system. Automatic pruning prevents bloat:

| Limit                          | Value     | Purpose                        |
| ------------------------------ | --------- | ------------------------------ |
| `MAX_RUNS_PER_SESSION`         | 50        | Cap trace history per session  |
| `MAX_SPANS_PER_RUN`            | 100       | Limit events per trace         |
| `MAX_CANDIDATES_PER_RETRIEVAL` | 10        | Limit logged chunk candidates  |
| `MAX_BYTES_PER_RUN`            | 100 KB    | Hard cap on trace size         |
| `MAX_SNIPPET_LENGTH`           | 100 chars | Truncate content in candidates |
| `MAX_QUERY_LENGTH`             | 500 chars | Truncate long queries          |

**When pruning happens:**

Pruning occurs at the **end of the workflow** in terminal nodes (`extractAndStoreKnowledge` and `clarificationResponse`), after the outcome is set but before the trace is returned. This ensures the complete trace is captured before pruning.

**What gets pruned:**

- Raw chunk content → replaced with short snippets
- Full embeddings → dropped entirely
- Large metadata values → truncated to 200 chars
- Old spans → only most recent N kept

**Candidate summaries:**

Instead of storing full chunk data, traces store lightweight summaries:

```typescript
type CandidateSummary = {
  id: string;
  documentId: string;
  score: number; // distance or confidence
  snippet: string; // first 100 chars
};
```

**Usage:**

```typescript
import { TraceUtil, TRACE_LIMITS } from './util/TraceUtil';

// Create pruned candidate summaries
const summaries = TraceUtil.createCandidateSummaries(chunks);

// Prune a trace before storage
const prunedTrace = TraceUtil.pruneTrace(trace);

// Prune session trace history
const prunedHistory = TraceUtil.pruneSessionTraces(traces);
```

### LangSmith Integration

LangGraph automatically traces all workflow runs to LangSmith when configured.

**Setup:**

```bash
# Add to .env.local
LANGCHAIN_TRACING_V2=true
LANGCHAIN_API_KEY=ls__...
LANGCHAIN_PROJECT=study-agent
```

**Custom Metadata:**

The trace utilities convert our domain-specific trace data to LangSmith-compatible metadata:

```typescript
import { LangSmithUtil } from './util/LangSmithUtil';

// Convert trace to LangSmith metadata
const metadata = LangSmithUtil.traceToMetadata(trace);
// {
//   'agent.traceId': '...',
//   'agent.outcome': 'success',
//   'agent.queryType': 'study_content',
//   'retrieval.embeddingCandidates': 40,
//   'retrieval.afterBudget': 8,
//   ...
// }

// Get a one-line summary for logging
const summary = LangSmithUtil.traceSummaryLine(trace);
// "[success] | 1234ms | type=study_content | chunks=8 | memories=2 | dist=0.234"

// Detect quality issues for alerting
const issues = LangSmithUtil.detectQualityIssues(trace);
// ['weak_top_match', 'slow_execution']
```

**Viewing in LangSmith:**

1. Go to your LangSmith project
2. Filter runs by custom metadata (e.g., `agent.outcome = error`)
3. Set up alerts for quality issues
4. Build dashboards tracking `retrieval.*` metrics

### Trace API Endpoint

The server exposes trace data via API:

```bash
# Get latest trace
curl http://localhost:3000/api/trace

# Include trace in chat response
curl -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "What is in my notes?", "includeTrace": true}'
```

**Response:**

```json
{
  "trace": {
    "traceId": "abc-123",
    "outcome": { "status": "success", "durationMs": 1234 },
    "spans": [...]
  },
  "metrics": { "agent.queryType": "study_content", ... },
  "issues": [],
  "summary": "[success] | 1234ms | type=study_content | chunks=8"
}
```

## Testing

### Test Strategy

```
┌─────────────────────────────────────────────────────────────────┐
│                        Vitest (CI)                              │
│  Mechanical correctness - "Does it work?"                       │
├─────────────────────────────────────────────────────────────────┤
│  test:unit       │ Pure functions (applyBudget, cosineSim)     │
│  test:smoke      │ Happy/alternate path - pipeline wired right │
│  test:retrieval  │ MRR, Recall@K - retrieval ranking quality   │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                    LangSmith (Scheduled)                        │
│  Quality evaluation - "Is it good?"                             │
├─────────────────────────────────────────────────────────────────┤
│  Response correctness, helpfulness, grounding                   │
│  Golden dataset regression, A/B experiments                     │
└─────────────────────────────────────────────────────────────────┘
```

### Test Commands

```bash
# Run all tests
npm test

# Run specific test suites
npm run test:unit           # Fast unit tests (~200ms)
npm run test:smoke          # End-to-end smoke tests (~20s)
npm run test:retrieval      # Retrieval quality metrics (~2s)
npm run test:integration    # Comprehensive pipeline tests (~2min)

# Setup
npm run test:seed           # Seed test data (run once before retrieval tests)

# Watch mode for development
npm run test:watch
```

### Smoke Tests

Minimal end-to-end tests to verify the agent pipeline is wired correctly.

| Test           | Path                                 | Verifies                                        |
| -------------- | ------------------------------------ | ----------------------------------------------- |
| Happy path     | Gate → Retrieval → Context → Extract | Full pipeline executes, success outcome         |
| Alternate path | Gate → Context (skip retrieval)      | Conversational queries skip retrieval correctly |

These are NOT quality evaluations — they just verify the pipeline doesn't break.

### Unit Tests

Unit tests run fast (~200ms) with no external dependencies. All external services are mocked.

**`documentUtil.test.ts`** - 28 tests covering:

| Function                | Tests                                                                                                |
| ----------------------- | ---------------------------------------------------------------------------------------------------- |
| `applyBudget`           | `maxChunks`, `maxPerDoc`, `maxContextTokens`, `maxChunkTokens`, combined constraints, empty input    |
| `estimateTokens`        | ~4 chars/token heuristic, empty string, rounding, whitespace handling                                |
| `cosineSimilarity`      | Identical vectors (1.0), orthogonal (0.0), opposite (-1.0), symmetry, high-dimensional, zero vectors |
| `removeDuplicateChunks` | High similarity removal, threshold behavior, missing embeddings                                      |

**`safeFetchJson.test.ts`** - 6 tests covering:

| Scenario | Expected |
|----------|----------|
| OK response + valid JSON | Returns parsed data |
| OK response + HTML body | Throws "Unexpected response from server" |
| `response.redirected = true` | Throws "Session expired" |
| URL without `/api/` | Throws "Session expired" |
| Error (500) + JSON body | Returns parsed error JSON |
| Error (502) + HTML body | Throws "Server error (502)" |

**`ingestBatching.test.ts`** - 5 tests covering:

| Scenario | Assertion |
|----------|-----------|
| 10 chunks (batch size 64) | 1 `embedBatch` call |
| 200 chunks (batch size 64) | 4 calls with sizes [64, 64, 64, 8] |
| 0 chunks | No `embedBatch` calls, returns chunkCount 0 |
| Embedding mapping | Each chunk gets correct embedding in `upsertChunks` |
| Temporal extraction | `extractTemporalRange` called for every chunk, data flows to DB |

**`embedBatch.test.ts`** - 5 tests covering:

| Scenario | Assertion |
|----------|-----------|
| Empty input | Returns `[]`, no API call |
| Single text | Calls API with `['text']`, returns 1 embedding |
| Multiple texts | Returns correct count, passes full array to API |
| Mismatched response count | Throws "expected N results, got M" |
| Retry config | `withRetry` called with `maxAttempts: 5, baseDelayMs: 2000` |

### Integration Tests

Integration tests run the full agent pipeline and assert on trace outcomes. These tests hit real APIs (Anthropic, VoyageAI) and require environment variables.

**What the tests verify:**

| Test Category      | Assertions                                                  |
| ------------------ | ----------------------------------------------------------- |
| Trace Outcomes     | `success` for valid queries, `clarified` for ambiguous ones |
| Retrieval Pipeline | Documents retrieved when expected, diagnostics captured     |
| Temporal Filtering | `queryYear` extracted and applied correctly                 |
| Performance        | Total duration < 30s, no span > 15s                         |
| Error Resilience   | Minimal/long queries handled gracefully                     |

**Example test:**

```typescript
it('should retrieve documents for study content queries', async () => {
  const { trace } = await runAgent('What does my resume say?');

  const gateSpan = trace?.spans.find((s) => s.node === 'retrievalGate');
  expect(gateSpan?.meta.shouldRetrieveDocuments).toBe(true);

  const retrievalSpan = trace?.spans.find((s) => s.node === 'retrieveMemoriesAndChunks');
  expect(retrievalSpan?.meta.embeddingCandidates).toBeGreaterThan(0);
});
```

**Test Configuration:**

Tests use a 60-second timeout (configured in `vitest.config.ts`) to accommodate API latency. Environment variables are loaded via `src/__tests__/setup.ts`.

## Evaluation Suite

The evaluation suite tests end-to-end agent behavior with structured assertions. Unlike unit tests, these run the full agent pipeline and evaluate response quality.

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Test Runner                            │
│         (runLocal.ts or runExperiment.ts)                   │
└─────────────────────┬───────────────────────────────────────┘
                      │
        ┌─────────────▼─────────────┐
        │        Dataset            │
        │      (dataset.ts)         │
        │   Test cases with         │
        │   expected behaviors      │
        └─────────────┬─────────────┘
                      │
        ┌─────────────▼─────────────┐
        │      Agent Invocation     │
        │   Run query through       │
        │   full agent pipeline     │
        └─────────────┬─────────────┘
                      │
        ┌─────────────▼─────────────┐
        │       Evaluators          │
        │     (evaluators.ts)       │
        │  Score response + trace   │
        └─────────────┬─────────────┘
                      │
        ┌─────────────▼─────────────┐
        │    Weighted Scoring       │
        │  Critical evaluators      │
        │  must pass (behavior)     │
        └───────────────────────────┘
```

### Running Evaluations

```bash
# 1. Seed test fixtures (required once, or after changing fixtures)
npx tsx src/evals/seed.ts

# 2. Run local evaluations
npx tsx src/evals/runLocal.ts

# Run with verbose output
npx tsx src/evals/runLocal.ts --verbose

# Run specific category
npx tsx src/evals/runLocal.ts --category off_topic

# 3. Run with LangSmith tracking (requires LANGCHAIN_API_KEY)
npx tsx src/evals/runExperiment.ts
```

### Test Categories

| Category               | Expected Behavior | What it tests                                 |
| ---------------------- | ----------------- | --------------------------------------------- |
| `study_content`        | ANSWER            | Questions about documents/notes               |
| `personal`             | ANSWER            | User-specific info (goals, history)           |
| `temporal_containment` | ANSWER            | Time-bound queries ("What did I do in 2023?") |
| `workflow`             | ANSWER            | Tool-triggering queries ("quiz me on X")      |
| `off_topic`            | REFUSE            | Lifestyle/opinion questions (stocks, fashion) |
| `unclear`              | CLARIFY           | Vague/ambiguous queries                       |

### Evaluators

Each evaluator returns a score (0-1), weight, and critical flag:

| Evaluator      | Weight | Critical | What it checks                            |
| -------------- | ------ | -------- | ----------------------------------------- |
| `behavior`     | 3.0    | Yes      | ANSWER/REFUSE/CLARIFY matches expected    |
| `routing`      | 2.0    | No       | Gate classified query correctly           |
| `retrieval`    | 1.0    | No       | Retrieved when expected, skipped when not |
| `budget`       | 1.0    | No       | Latency and token usage within thresholds |
| `contains_any` | 1.5    | No       | Response contains expected keywords       |
| `must_cover`   | 1.5    | No       | Response covers expected topics           |
| `amount`       | 2.0    | No       | Numeric values match expected             |

**Scoring:**

- Critical evaluators must pass (score = 1.0) or entire test fails
- Non-critical evaluators contribute to weighted average
- Pass threshold: weighted score ≥ 70%

### Behavior Detection

The evaluator uses **trace-first** detection with text fallback:

1. Check gate `queryType` from trace (most reliable)
   - `off_topic` → REFUSE
   - `needsClarification` → CLARIFY
2. Fall back to response text pattern matching
   - Refusal patterns: "I'm a study assistant", "outside my expertise", etc.
   - Clarification patterns: "could you clarify", "what are you referring to", etc.

### Test Fixtures

Test documents are defined in `src/evals/fixtures/evalDocuments.ts` with fake data:

| Document       | Content                                             |
| -------------- | --------------------------------------------------- |
| User Profile   | Fake career info, severance ($42,500), work history |
| Lost in Middle | Summary of position effects in LLM context          |
| ReAct Paper    | Reasoning + acting framework explanation            |
| React Docs     | JavaScript library overview                         |
| Hair Loss      | Finasteride vs dutasteride comparison               |

The seed script ingests these under a dedicated `EVAL_USER_ID` so tests run against consistent data regardless of your personal documents.

### Adding New Test Cases

1. Add the test case to `src/evals/dataset.ts`:

```typescript
{
  userQuery: 'What is transformer architecture?',
  category: 'study_content',
  expected_behavior: 'ANSWER',
  answer_must_contain_any: ['attention', 'encoder', 'decoder'],
  dataset_split: ['base'],
}
```

2. Add corresponding fixture document to `src/evals/fixtures/evalDocuments.ts` if needed

3. Re-run seed: `npx tsx src/evals/seed.ts`

4. Run evals: `npx tsx src/evals/runLocal.ts`

### Files

| File                                  | Purpose                                        |
| ------------------------------------- | ---------------------------------------------- |
| `src/evals/dataset.ts`                | Test cases with expected behaviors             |
| `src/evals/evaluators.ts`             | Scoring functions (behavior, routing, content) |
| `src/evals/runLocal.ts`               | Local test runner (no external deps)           |
| `src/evals/runExperiment.ts`          | LangSmith experiment runner                    |
| `src/evals/seed.ts`                   | Seeds fixture documents into database          |
| `src/evals/fixtures/evalDocuments.ts` | Fake test documents                            |
