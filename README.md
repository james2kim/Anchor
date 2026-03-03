# Persistent Memory Study Agent

A conversational AI study assistant with persistent memory, document RAG, and intelligent retrieval. Built with LangGraph, React, PostgreSQL (pgvector), and Redis.

## Features

- **Persistent Memory** - Extracts and stores facts, goals, preferences, and decisions from conversations
- **Document RAG** - Upload and query documents with hybrid search (semantic + keyword + temporal)
- **Session Continuity** - Redis-backed sessions with automatic summary archival to long-term memory
- **Smart Retrieval** - Hybrid Rule-Based and LLM-powered retrieval gate that decides when to search documents vs. memories vs. neither
- **React Web UI** - Mobile-responsive chat interface with document upload and markdown rendering
- **User Authentication** - Clerk-based auth with automatic user provisioning and per-user data isolation
- **Production Resilience** - Rate limiting, retry with exponential backoff on external APIs, and graceful fallback to keyword-only search when embeddings are unavailable

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                         User Query                                   │
└─────────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      LangGraph Workflow                              │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                     retrievalGate                             │   │
│  │  • LLM assesses query type (personal/study/general/off-topic) │   │
│  │  • Generates query embedding in parallel                      │   │
│  │  • Policy decides: retrieve docs? memories? clarify?          │   │
│  └──────────────────────────┬───────────────────────────────────┘   │
│              ┌──────────────┴──────────────┐                        │
│              ▼                             ▼                        │
│  ┌──────────────────────┐    ┌─────────────────────────────────┐   │
│  │ clarificationResponse│    │  retrieveMemoriesAndChunks      │   │
│  │  (if ambiguous)      │    │  • Hybrid search (embedding+BM25)│   │
│  └──────────────────────┘    │  • Temporal filtering            │   │
│                              │  • RRF fusion                    │   │
│                              └─────────────┬───────────────────┘   │
│                                            ▼                        │
│                              ┌─────────────────────────────────┐   │
│                              │        injectContext             │   │
│                              │  • U-shape distribution          │   │
│                              │  • Build context + generate reply│   │
│                              └─────────────┬───────────────────┘   │
│                                            ▼                        │
│                              ┌─────────────────────────────────┐   │
│                              │   extractAndStoreKnowledge       │   │
│                              │  • Extract facts/goals/prefs     │   │
│                              │  • Dedupe via cosine similarity  │   │
│                              │  • Summarize messages (background)│   │
│                              └─────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
         │                                        │
         ▼                                        ▼
┌─────────────────────┐              ┌─────────────────────────┐
│    PostgreSQL       │              │         Redis           │
│   (Long-term)       │              │      (Short-term)       │
│                     │              │                         │
│  • memories (pgvector)             │  • Session state        │
│  • documents         │              │  • Messages + summary   │
│  • chunks (hybrid idx)│             │  • LangGraph checkpoints│
└─────────────────────┘              └─────────────────────────┘
```

## Memory Architecture

### Short-Term Memory (Redis)

Session-scoped memory with 24-hour TTL:

| Key Pattern | Purpose |
|-------------|---------|
| `session:<id>` | Session state (messages, summary, taskState) |
| `checkpoint:<thread_id>:latest` | LangGraph checkpoint for workflow resumption |
| `user:<id>:active_session` | Maps user to their active session |

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

## Workflow Nodes

### 1. retrievalGate
Routes queries based on rule-based classification + LLM fallback + deterministic policy.

**Rule-Based Classification** (instant, free):
Handles 60-70% of queries without LLM calls:
- Greetings/thanks → `conversational`
- Personal statements ("I am/like/prefer...") → `personal`
- Personal questions ("my goal", "what did I say") → `personal`
- Topic questions ("explain X", "what is Y") → `study_content`
- Lifestyle advice ("should I nap?") → `off_topic`

**LLM Assessment** (Haiku - for ambiguous cases):
- `queryType`: personal | study_content | general_knowledge | conversational | off_topic | unclear
- `referencesPersonalContext`: boolean

**Policy** (deterministic):
- `conversational` or `off_topic` → skip all retrieval
- `study_content` → search documents + memories (for personalization)
- `personal` → search documents + memories with full budget
- `unclear` → request clarification

### 2. retrieveMemoriesAndChunks
Executes hybrid search based on gate decision.

**Two-Tier Memory Retrieval:**
Profile memories (preferences, facts) are always relevant for personalization but don't match well via semantic similarity (e.g., "give me a code example" won't semantically match "prefers TypeScript"). Solution:

1. **Tier 1 - Profile memories**: Fetch preferences + facts by confidence (no embedding needed)
2. **Tier 2 - Contextual memories**: Similarity search for goals, decisions, summaries

| Budget | Profile | Contextual | Total |
|--------|---------|------------|-------|
| Full   | 3       | 2          | 5     |
| Minimal| 2       | 0          | 2     |

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

| Trigger | Action |
|---------|--------|
| Messages reach 15 | Summarize oldest 10, keep newest 5 |
| Result | Messages oscillate between 5-15 |

```
Before: [m1, m2, m3, m4, m5, m6, m7, m8, m9, m10, m11, m12, m13, m14, m15]
                    ↓ summarize oldest 10
After:  [summary] + [m11, m12, m13, m14, m15]
```

The summary is appended to the session's running summary, preserving context across pruning cycles.

### 5. clarificationResponse
Handles ambiguous queries by asking for clarification.

## Key Architecture Decisions

### 1. HNSW Vector Index

Similarity search on the `chunks.embedding` column uses an HNSW (Hierarchical Navigable Small World) index instead of sequential scan. HNSW builds a multi-layered graph over the vectors — top layers have sparse, long-range connections for coarse navigation, bottom layers have dense, short-range connections for precise lookup. Search traverses top-down in O(log n) hops rather than computing distance against every row (O(n)).

| Parameter | Value | Effect |
|-----------|-------|--------|
| `m` | 16 | Max connections per node. Higher = better recall, more memory |
| `ef_construction` | 64 | Build-time candidate list. Higher = better graph quality, slower builds |
| `ef_search` | 40 (pgvector default) | Query-time candidate list. Tunable per-query via `SET hnsw.ef_search` |
| Operator class | `vector_cosine_ops` | Matches the `<=>` cosine distance operator used in queries |

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

| Scenario | Model | Rationale |
|----------|-------|-----------|
| No context needed | Haiku | Conversational queries don't need heavy reasoning |
| Good retrieval (≥2 chunks, distance ≤0.6) | Haiku | Synthesizing from strong sources is straightforward |
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

### 11. Authentication with Clerk

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

## Project Structure

```
├── frontend/                    # React frontend (Vite)
│   ├── src/
│   │   ├── components/          # React components
│   │   ├── hooks/               # Custom hooks (useChat)
│   │   ├── api/                 # API client
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
    │       ├── injectContext.ts
    │       ├── extractKnowledge.ts
    │       ├── clarificationResponse.ts
    │       └── summarize.ts
    │
    ├── stores/
    │   ├── DocumentStore.ts     # Hybrid search, chunk management
    │   ├── MemoryStore.ts       # Long-term memory operations
    │   ├── RedisSessionStore.ts # Session state management
    │   └── UserStore.ts         # User CRUD operations
    │
    ├── memory/
    │   └── RedisCheckpointer.ts # LangGraph checkpoint persistence
    │
    ├── llm/
    │   ├── retrievalAssessor.ts # Query classification
    │   ├── promptBuilder.ts     # Context block + system prompt
    │   ├── summarizeMessages.ts # Conversation summarization
    │   └── extractMemories.ts   # Knowledge extraction
    │
    ├── ingest/
    │   └── ingestDocument.ts    # Document chunking + embedding
    │
    ├── services/
    │   └── EmbeddingService.ts  # VoyageAI embeddings
    │
    ├── util/
    │   ├── DocumentUtil.ts      # Text chunking
    │   ├── TemporalUtil.ts      # Date range extraction
    │   ├── EmbeddingUtil.ts     # Vector formatting
    │   └── RetryUtil.ts         # Retry with exponential backoff
    │
    ├── schemas/
    │   └── types.ts             # Zod schemas and TypeScript types
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
Send a message and get a response.

```json
Request:  { "message": "What's in my biology notes?" }
Response: { "response": "Based on your notes...", "sessionId": "..." }
```

### POST /api/upload
Upload a document for ingestion.

```
Request:  FormData with file
Response: { "documentId": "...", "chunkCount": 15 }
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

| Constant | Location | Default | Description |
|----------|----------|---------|-------------|
| `MAX_MESSAGES` | `constants.ts` | 15 | Triggers summarization (oldest 10 summarized, newest 5 kept) |
| `STALE_HOURS` | `RedisSessionStore.ts` | 12 | Hours before session summary archival |
| `TTL` | `RedisSessionStore.ts` | 86400 | Session expiration (24 hours) |
| `SIMILARITY_THRESHOLD` | `extractKnowledge.ts` | 0.9 | Memory deduplication threshold |
| `RRF_K` | `DocumentStore.ts` | 60 | RRF fusion constant |

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

| Metric | Description | Threshold |
|--------|-------------|-----------|
| **MRR** | Mean Reciprocal Rank — average of 1/rank of first relevant result | ≥ 0.65 |
| **Recall@5** | Fraction of relevant docs appearing in top 5 results | ≥ 0.65 |
| **Disambiguation** | Correct doc ranks above keyword-similar-but-wrong doc | ≥ 0.70 |

### Test Categories

| Category | What it tests |
|----------|---------------|
| Temporal | Date range filtering ("what did I do in 2023") |
| Semantic | Meaning-based retrieval without exact keywords |
| Keyword | Direct term matching ("ClickHouse migration") |
| Study content | Document content retrieval |
| Disambiguation | Correct doc outranks keyword-similar doc (e.g., "axiom in math" ranks math notes above "Axiom" company resume) |
| Edge cases | Typos, long queries, single-word queries |

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
  spans: TraceSpan[];      // Append-only, each node adds one
  outcome: TraceOutcome;   // Set once at the end
}

interface TraceSpan {
  node: string;            // 'retrievalGate', 'hybridSearch', etc.
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

| Node | Metadata |
|------|----------|
| `retrievalGate` | queryType, wasRewritten, shouldRetrieveDocuments, shouldRetrieveMemories |
| `retrieveMemoriesAndChunks` | profileMemories, contextualMemories, chunksRetrieved (+ hybrid search diagnostics) |
| `injectContext` | documentsUsed, memoriesUsed, contextTokens, responseLength |
| `extractAndStoreKnowledge` | contentType, memoriesAdded, studyMaterialIngested |
| `clarificationResponse` | responseLength |

### Retrieval Diagnostics

The `retrieveMemoriesAndChunks` node captures detailed pipeline diagnostics to pinpoint where retrieval quality degrades:

| Stage | Metrics | What it tells you |
|-------|---------|-------------------|
| **Hybrid Search** | `embeddingCandidates`, `keywordCandidates`, `fusionOverlap`, `fusedCount`, `topEmbeddingDistance` | How many chunks each search found, overlap between them |
| **Pipeline** | `afterRelevanceFilter`, `afterDedup`, `afterBudget` | Chunk counts after each filtering stage |
| **Quality** | `topChunkDistance`, `scoreSpread`, `uniqueDocuments` | Confidence signals for retrieval quality |
| **Temporal** | `temporalFilterApplied`, `queryYear` | Whether date filtering was used |

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

| Limit | Value | Purpose |
|-------|-------|---------|
| `MAX_RUNS_PER_SESSION` | 50 | Cap trace history per session |
| `MAX_SPANS_PER_RUN` | 100 | Limit events per trace |
| `MAX_CANDIDATES_PER_RETRIEVAL` | 10 | Limit logged chunk candidates |
| `MAX_BYTES_PER_RUN` | 100 KB | Hard cap on trace size |
| `MAX_SNIPPET_LENGTH` | 100 chars | Truncate content in candidates |
| `MAX_QUERY_LENGTH` | 500 chars | Truncate long queries |

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
  score: number;      // distance or confidence
  snippet: string;    // first 100 chars
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

| Test | Path | Verifies |
|------|------|----------|
| Happy path | Gate → Retrieval → Context → Extract | Full pipeline executes, success outcome |
| Alternate path | Gate → Context (skip retrieval) | Conversational queries skip retrieval correctly |

These are NOT quality evaluations — they just verify the pipeline doesn't break.

### Unit Tests

Unit tests for pure utility functions run fast (~200ms) with no external dependencies.

**`documentUtil.test.ts`** - 28 tests covering:

| Function | Tests |
|----------|-------|
| `applyBudget` | `maxChunks`, `maxPerDoc`, `maxContextTokens`, `maxChunkTokens`, combined constraints, empty input |
| `estimateTokens` | ~4 chars/token heuristic, empty string, rounding, whitespace handling |
| `cosineSimilarity` | Identical vectors (1.0), orthogonal (0.0), opposite (-1.0), symmetry, high-dimensional, zero vectors |
| `removeDuplicateChunks` | High similarity removal, threshold behavior, missing embeddings |

### Integration Tests

Integration tests run the full agent pipeline and assert on trace outcomes. These tests hit real APIs (Anthropic, VoyageAI) and require environment variables.

**What the tests verify:**

| Test Category | Assertions |
|---------------|------------|
| Trace Outcomes | `success` for valid queries, `clarified` for ambiguous ones |
| Retrieval Pipeline | Documents retrieved when expected, diagnostics captured |
| Temporal Filtering | `queryYear` extracted and applied correctly |
| Performance | Total duration < 30s, no span > 15s |
| Error Resilience | Minimal/long queries handled gracefully |

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

| Category | Expected Behavior | What it tests |
|----------|------------------|---------------|
| `study_content` | ANSWER | Questions about documents/notes |
| `personal` | ANSWER | User-specific info (goals, history) |
| `temporal_containment` | ANSWER | Time-bound queries ("What did I do in 2023?") |
| `off_topic` | REFUSE | Lifestyle/opinion questions (stocks, fashion) |
| `unclear` | CLARIFY | Vague/ambiguous queries |

### Evaluators

Each evaluator returns a score (0-1), weight, and critical flag:

| Evaluator | Weight | Critical | What it checks |
|-----------|--------|----------|----------------|
| `behavior` | 3.0 | Yes | ANSWER/REFUSE/CLARIFY matches expected |
| `routing` | 2.0 | No | Gate classified query correctly |
| `retrieval` | 1.0 | No | Retrieved when expected, skipped when not |
| `budget` | 1.0 | No | Latency and token usage within thresholds |
| `contains_any` | 1.5 | No | Response contains expected keywords |
| `must_cover` | 1.5 | No | Response covers expected topics |
| `amount` | 2.0 | No | Numeric values match expected |

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

| Document | Content |
|----------|---------|
| User Profile | Fake career info, severance ($42,500), work history |
| Lost in Middle | Summary of position effects in LLM context |
| ReAct Paper | Reasoning + acting framework explanation |
| React Docs | JavaScript library overview |
| Hair Loss | Finasteride vs dutasteride comparison |

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

| File | Purpose |
|------|---------|
| `src/evals/dataset.ts` | Test cases with expected behaviors |
| `src/evals/evaluators.ts` | Scoring functions (behavior, routing, content) |
| `src/evals/runLocal.ts` | Local test runner (no external deps) |
| `src/evals/runExperiment.ts` | LangSmith experiment runner |
| `src/evals/seed.ts` | Seeds fixture documents into database |
| `src/evals/fixtures/evalDocuments.ts` | Fake test documents |
