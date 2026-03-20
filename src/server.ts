import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import multer from 'multer';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { clerkMiddleware, getAuth, requireAuth } from '@clerk/express';

import { RedisSessionStore } from './stores/RedisSessionStore';
import { RedisCheckpointer } from './memory/RedisCheckpointer';
import { UserStore } from './stores/UserStore';
import { buildWorkflow } from './agent/graph';
import { ingestDocument } from './ingest/ingestDocument';
import { extractTextFromFile } from './ingest/processGcsFile';
import { DocumentStore } from './stores/DocumentStore';
import { db } from './db/knex';
import { runBackgroundSummarization, runBackgroundExtraction } from './agent/backgroundTasks';
import { MAX_MESSAGES } from './agent/constants';
import { LangSmithUtil } from './util/LangSmithUtil';
import { TitleExtractor } from './util/TitleExtractor';
import { summarizeDocumentText } from './llm/summarizeDocument';
import {
  generateSignedUploadUrl,
  fileExists,
} from './util/GcsUtil';
import { initializeQueues, shutdownQueues, getFileProcessingQueue, getJobStatus } from './queue';
import type { AgentTrace } from './schemas/types';
import { setCircuitBreakerRedis } from './util/RetryUtil';
import { WorkflowRunStore } from './stores/WorkflowRunStore';

// Supported file types
const SUPPORTED_EXTENSIONS = ['.pdf', '.docx', '.doc', '.md', '.txt'];
const SUPPORTED_MIMETYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  'text/markdown',
  'text/plain',
];

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT ?? 3000;
const isProduction = process.env.NODE_ENV === 'production';

// Middleware

// Security headers
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", 'https://*.clerk.accounts.dev'],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://*.clerk.accounts.dev'],
        imgSrc: ["'self'", 'data:', 'https://*.clerk.accounts.dev', 'https://img.clerk.com'],
        connectSrc: ["'self'", 'https://*.clerk.accounts.dev', 'https://storage.googleapis.com'],
        frameSrc: ["'self'", 'https://*.clerk.accounts.dev'],
        fontSrc: ["'self'", 'https://*.clerk.accounts.dev'],
        workerSrc: ["'self'", 'blob:'],
      },
    },
  })
);

// CORS
const allowedOrigins = isProduction
  ? ['https://anchor-cd21e.web.app', 'https://anchor-cd21e.firebaseapp.com', 'https://anchoragent.dev', 'https://www.anchoragent.dev']
  : ['http://localhost:3000', 'http://localhost:5173', 'http://localhost:5174'];

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow same-origin requests (origin is undefined) and allowed origins
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    credentials: true,
    exposedHeaders: ['X-RateLimit-Limit', 'X-RateLimit-Remaining'],
  })
);

app.use(express.json());
app.use(clerkMiddleware());
app.use(express.static(path.join(__dirname, '../public')));

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
});

// Rate limiting (production only)
const DAILY_CHAT_LIMIT = 40;
const DAILY_UPLOAD_LIMIT = 15;
const RATE_LIMIT_TTL = 86400; // 24 hours in seconds

async function checkRateLimit(
  userId: string,
  resource: 'chat' | 'upload' = 'chat'
): Promise<{ allowed: boolean; remaining: number }> {
  const limit = resource === 'chat' ? DAILY_CHAT_LIMIT : DAILY_UPLOAD_LIMIT;
  if (!isProduction) return { allowed: true, remaining: limit };

  const key = `ratelimit:${resource}:${userId}`;
  const client = RedisSessionStore.getClient();

  const count = await client.incr(key);

  // Set TTL on first request of the window
  if (count === 1) {
    await client.expire(key, RATE_LIMIT_TTL);
  }

  const remaining = Math.max(0, limit - count);
  return { allowed: count <= limit, remaining };
}

// Global state (initialized on startup)
let agentApp: ReturnType<typeof buildWorkflow>;
let documentStore: DocumentStore;

// Cache for user sessions (userId -> sessionId)
const userSessions = new Map<string, string>();

// Get or create user from Clerk auth
async function getOrCreateUser(clerkUserId: string, email?: string): Promise<string> {
  // Check if user exists with this Clerk ID stored in email field (temporary mapping)
  // In production, you'd have a clerk_id column
  let user = await UserStore.findByEmail(email ?? `clerk_${clerkUserId}@temp.local`);

  if (!user) {
    user = await UserStore.create({
      email: email ?? `clerk_${clerkUserId}@temp.local`,
      name: undefined,
    });
    console.log(`Created new user: ${user.id} for Clerk user: ${clerkUserId}`);
  }

  return user.id;
}

// Get session for authenticated user
async function getUserSession(userId: string): Promise<string> {
  let sessionId = userSessions.get(userId);

  if (!sessionId) {
    const session = await RedisSessionStore.getOrCreateSession(userId);
    sessionId = session.sessionId;
    userSessions.set(userId, sessionId);
  }

  return sessionId;
}

// Initialize the agent and stores
async function initialize() {
  console.log('Connecting to Redis...');
  await RedisSessionStore.connect();
  setCircuitBreakerRedis(RedisSessionStore.getClient());

  console.log('Initializing job queues...');
  await initializeQueues();

  const checkpointer = new RedisCheckpointer(RedisSessionStore);
  agentApp = buildWorkflow(checkpointer);
  documentStore = new DocumentStore(db, 1024);

  console.log('Server initialized');
}

// Helper to get formatted response from the agent
async function getFormattedAnswerToUserinput(userQuery: string, sessionId: string, userId: string) {
  const userMessage = {
    id: crypto.randomUUID(),
    role: 'user',
    content: userQuery,
    createdAt: new Date().toISOString(),
  };

  const result = await agentApp.invoke(
    {
      messages: [userMessage],
      userQuery: userQuery,
      userId,
      sessionId,
    },
    { configurable: { thread_id: sessionId } }
  );

  return result;
}

// API Routes

// POST /api/chat - Send a message and get a response
app.post('/api/chat', requireAuth(), async (req, res) => {
  try {
    const { userId: clerkUserId } = getAuth(req);
    if (!clerkUserId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { message, includeTrace } = req.body;

    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'Message is required' });
    }

    if (message.length > 10_000) {
      return res.status(400).json({ error: 'Message too long (max 10,000 characters)' });
    }

    // Get or create user and session
    const userId = await getOrCreateUser(clerkUserId);

    // Rate limit check (production only)
    const { allowed, remaining } = await checkRateLimit(userId);
    if (!allowed) {
      res.set('X-RateLimit-Limit', String(DAILY_CHAT_LIMIT));
      res.set('X-RateLimit-Remaining', '0');
      return res.status(429).json({
        error: `Daily message limit reached (${DAILY_CHAT_LIMIT}/day). Please try again tomorrow.`,
      });
    }

    const sessionId = await getUserSession(userId);

    const result = await getFormattedAnswerToUserinput(message, sessionId, userId);
    const trace = result?.trace as AgentTrace | undefined;

    // Log trace summary
    if (trace) {
      console.log(`[trace] ${LangSmithUtil.traceSummaryLine(trace)}`);

      // Check for quality issues
      const issues = LangSmithUtil.detectQualityIssues(trace);
      if (issues.length > 0) {
        console.warn(`[trace] Quality issues detected: ${issues.join(', ')}`);
      }
    }

    // Build response
    const response: Record<string, unknown> = {
      response: result?.response ?? '[No response generated]',
      sessionId,
    };

    if (result?.workflowData !== undefined) {
      response.workflowData = result.workflowData;
    }

    // Optionally include trace data (for debugging/monitoring)
    if (includeTrace && trace) {
      response.trace = {
        traceId: trace.traceId,
        outcome: trace.outcome,
        spans: trace.spans.map((s) => ({
          node: s.node,
          durationMs: s.durationMs,
          meta: s.meta,
        })),
        metrics: LangSmithUtil.traceToMetadata(trace),
      };
    }

    res.set('X-RateLimit-Limit', String(DAILY_CHAT_LIMIT));
    res.set('X-RateLimit-Remaining', String(remaining));
    res.json(response);

    // Run background tasks (fire and forget)

    // Background knowledge extraction - extracts memories/study materials from user query
    runBackgroundExtraction(message, userId).catch((err) =>
      console.error('[/api/chat] Background extraction error:', err)
    );

    // Background summarization - when message count hits threshold
    if (result?.messages && result.messages.length >= MAX_MESSAGES) {
      console.log(
        `[/api/chat] Triggering background summarization (${result.messages.length} messages)`
      );
      runBackgroundSummarization(sessionId, userId, result.messages, result.summary ?? '').catch(
        (err) => console.error('[/api/chat] Background summarization error:', err)
      );
    }
  } catch (err) {
    console.error('Error in /api/chat:', err);
    res.status(500).json({ error: 'Failed to process message' });
  }
});

// POST /api/upload - Upload a document for ingestion
app.post('/api/upload', requireAuth(), (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'File too large. Maximum size is 100 MB.' });
      }
      return res.status(400).json({ error: err.message });
    }
    next();
  });
}, async (req, res) => {
  try {
    const { userId: clerkUserId } = getAuth(req);
    if (!clerkUserId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const userId = await getOrCreateUser(clerkUserId);

    // Upload rate limit check
    const { allowed } = await checkRateLimit(userId, 'upload');
    if (!allowed) {
      return res.status(429).json({
        error: `Daily upload limit reached (${DAILY_UPLOAD_LIMIT}/day). Please try again tomorrow.`,
      });
    }

    const { originalname, buffer, mimetype } = req.file;
    const ext = path.extname(originalname).toLowerCase();

    // Validate file type
    if (!SUPPORTED_EXTENSIONS.includes(ext) && !SUPPORTED_MIMETYPES.includes(mimetype)) {
      return res.status(400).json({
        error: `Unsupported file type. Supported formats: ${SUPPORTED_EXTENSIONS.join(', ')}`,
      });
    }

    // Extract text using LangChain loaders
    const { text: textContent, pdfTitle } = await extractTextFromFile(
      buffer,
      originalname,
      mimetype
    );

    if (!textContent || textContent.trim().length === 0) {
      return res.status(400).json({
        error: 'Could not extract text from file. The file may be empty or corrupted.',
      });
    }

    // Extract title: PDF metadata > heuristics > filename
    const extractedTitle = pdfTitle || TitleExtractor.extractTitle(textContent, originalname);
    console.log(`[upload] Title: "${extractedTitle}" (from PDF metadata: ${!!pdfTitle})`);

    const result = await ingestDocument(
      db,
      { documents: documentStore },
      {
        source: originalname,
        title: extractedTitle,
        text: textContent,
        metadata: {
          uploadedAt: new Date().toISOString(),
          originalName: originalname,
          mimeType: mimetype,
          fileType: ext,
        },
      },
      userId
    );

    res.json({
      documentId: result.documentId,
      chunkCount: result.chunkCount,
      filename: originalname,
      title: extractedTitle,
    });

    // Fire-and-forget: generate summary
    summarizeDocumentText(textContent)
      .then((summary) => documentStore.updateSummary(result.documentId, summary))
      .then(() => console.log(`[upload] Summary generated for ${result.documentId}`))
      .catch((err) => console.error('[upload] Summary generation failed (non-fatal):', err));
  } catch (err) {
    console.error('Error in /api/upload:', err);
    const message = err instanceof Error ? err.message : 'Failed to process upload';
    res.status(500).json({ error: message });
  }
});

// POST /api/upload/signed-url - Generate a signed URL for direct GCS upload
app.post('/api/upload/signed-url', requireAuth(), async (req, res) => {
  try {
    const { userId: clerkUserId } = getAuth(req);
    if (!clerkUserId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const userId = await getOrCreateUser(clerkUserId);

    // Upload rate limit check
    const { allowed } = await checkRateLimit(userId, 'upload');
    if (!allowed) {
      return res.status(429).json({
        error: `Daily upload limit reached (${DAILY_UPLOAD_LIMIT}/day). Please try again tomorrow.`,
      });
    }

    const { filename, contentType, fileSize } = req.body;

    if (!filename || typeof filename !== 'string') {
      return res.status(400).json({ error: 'filename is required' });
    }
    if (!contentType || typeof contentType !== 'string') {
      return res.status(400).json({ error: 'contentType is required' });
    }

    // Validate file extension
    const ext = path.extname(filename).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.includes(ext)) {
      return res.status(400).json({
        error: `Unsupported file type. Supported formats: ${SUPPORTED_EXTENSIONS.join(', ')}`,
      });
    }

    // Validate content type
    if (!SUPPORTED_MIMETYPES.includes(contentType)) {
      return res.status(400).json({
        error: `Unsupported content type: ${contentType}`,
      });
    }

    // Validate file size (max 100 MB)
    const MAX_FILE_SIZE = 100 * 1024 * 1024;
    if (fileSize && typeof fileSize === 'number' && fileSize > MAX_FILE_SIZE) {
      return res.status(400).json({ error: 'File too large. Maximum size is 100 MB.' });
    }

    const fileId = crypto.randomUUID();

    const { signedUrl, gcsPath } = await generateSignedUploadUrl({
      userId,
      fileId,
      filename,
      contentType,
    });

    res.json({ signedUrl, fileId, gcsPath });
  } catch (err) {
    console.error('Error in /api/upload/signed-url:', err);
    res.status(500).json({ error: 'Failed to generate signed URL' });
  }
});

// POST /api/upload/process - Process a file already uploaded to GCS via BullMQ queue
app.post('/api/upload/process', requireAuth(), async (req, res) => {
  try {
    const { userId: clerkUserId } = getAuth(req);
    if (!clerkUserId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { fileId, gcsPath, filename } = req.body;

    if (!fileId || typeof fileId !== 'string') {
      return res.status(400).json({ error: 'fileId is required' });
    }
    if (!gcsPath || typeof gcsPath !== 'string') {
      return res.status(400).json({ error: 'gcsPath is required' });
    }
    if (!filename || typeof filename !== 'string') {
      return res.status(400).json({ error: 'filename is required' });
    }

    const userId = await getOrCreateUser(clerkUserId);

    // Security: ensure the gcsPath belongs to this user
    const expectedPrefix = `uploads/${userId}/`;
    if (!gcsPath.startsWith(expectedPrefix)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Verify the file exists in GCS
    const exists = await fileExists(gcsPath);
    if (!exists) {
      return res.status(404).json({ error: 'File not found in storage. It may have expired.' });
    }

    // Enqueue via BullMQ — unified path for both prod and dev
    const queue = getFileProcessingQueue();
    await queue.add(
      'process-file',
      {
        userId,
        gcsPath,
        filename,
        fileId,
        enqueuedAt: new Date().toISOString(),
      },
      { jobId: fileId }
    );

    console.log(`[upload/process] Enqueued job ${fileId} for ${filename}`);
    res.json({ jobId: fileId, status: 'queued' });
  } catch (err) {
    console.error('Error in /api/upload/process:', err);
    const message = err instanceof Error ? err.message : 'Failed to process upload';
    res.status(500).json({ error: message });
  }
});

// GET /api/upload/status/:jobId - Check processing job status via BullMQ
app.get('/api/upload/status/:jobId', requireAuth(), async (req, res) => {
  try {
    const { userId: clerkUserId } = getAuth(req);
    if (!clerkUserId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    res.set('Cache-Control', 'no-store');

    const jobId = req.params.jobId as string;
    const userId = await getOrCreateUser(clerkUserId);

    const status = await getJobStatus(jobId, userId);
    if (!status) {
      return res.status(404).json({ error: 'Job not found or expired' });
    }

    return res.json(status);
  } catch (err) {
    console.error('Error in /api/upload/status:', err);
    res.status(500).json({ error: 'Failed to check job status' });
  }
});

// GET /api/session - Get current session info
app.get('/api/session', requireAuth(), async (req, res) => {
  try {
    const { userId: clerkUserId } = getAuth(req);
    if (!clerkUserId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const userId = await getOrCreateUser(clerkUserId);
    const sessionId = await getUserSession(userId);
    const { state } = await RedisSessionStore.getSession(sessionId, userId);

    console.log('[/api/session] Session ID:', sessionId);
    console.log('[/api/session] Raw state keys:', Object.keys(state));
    console.log('[/api/session] Raw messages count:', state.messages?.length ?? 0);
    console.log(
      '[/api/session] Raw messages sample:',
      JSON.stringify(state.messages?.[0], null, 2)
    );

    // Also check the checkpointer directly
    const checkpointKey = `checkpoint:${sessionId}:latest`;
    const checkpointRaw = await RedisSessionStore.getClient().get(checkpointKey);
    if (checkpointRaw) {
      const checkpoint = JSON.parse(checkpointRaw);
      const cpMessages = checkpoint?.checkpoint?.channel_values?.messages;
      console.log('[/api/session] Checkpoint messages count:', cpMessages?.length ?? 0);
      console.log(
        '[/api/session] Checkpoint message sample:',
        JSON.stringify(cpMessages?.[0], null, 2)
      );
    } else {
      console.log('[/api/session] No checkpoint found for key:', checkpointKey);
    }

    // Normalize LangChain messages to plain objects
    const normalizedMessages = (state.messages || [])
      .map((msg: unknown) => {
        const m = msg as Record<string, unknown>;

        // Check if already a plain object with role
        if (typeof m.role === 'string' && typeof m.content === 'string') {
          return { role: m.role, content: m.content };
        }

        // LangChain serialized format:
        // { id: ["langchain_core", "messages", "HumanMessage"], kwargs: { content: "..." } }
        const msgId = m.id as string[] | undefined;
        const kwargs = m.kwargs as Record<string, unknown> | undefined;
        const msgType = Array.isArray(msgId) ? msgId[2]?.toLowerCase() || '' : '';

        // Determine role
        let role = 'system';
        if (msgType.includes('human')) {
          role = 'user';
        } else if (msgType.includes('ai')) {
          role = 'assistant';
        } else if (msgType.includes('tool')) {
          role = 'system'; // Skip tool messages or show as system
        }

        // Extract content from kwargs
        let content = kwargs?.content ?? m.content ?? '';
        if (Array.isArray(content)) {
          content = content
            .map((c: unknown) =>
              typeof c === 'string' ? c : (c as Record<string, unknown>).text || ''
            )
            .join('');
        }

        return { role, content: String(content) };
      })
      .filter(
        (m: { content: string; role: string }) =>
          m.content && m.content.trim().length > 0 && m.role !== 'system'
      );

    console.log('[/api/session] Normalized messages count:', normalizedMessages.length);

    res.json({
      sessionId,
      messages: normalizedMessages,
    });
  } catch (err) {
    console.error('Error in /api/session:', err);
    res.status(500).json({ error: 'Failed to get session' });
  }
});

// GET /api/trace - Get the latest trace from the session
app.get('/api/trace', requireAuth(), async (req, res) => {
  try {
    const { userId: clerkUserId } = getAuth(req);
    if (!clerkUserId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const userId = await getOrCreateUser(clerkUserId);
    const sessionId = await getUserSession(userId);

    // Get the latest checkpoint which contains the trace
    const checkpointKey = `checkpoint:${sessionId}:latest`;
    const checkpointRaw = await RedisSessionStore.getClient().get(checkpointKey);

    if (!checkpointRaw) {
      return res.status(404).json({ error: 'No trace found' });
    }

    const checkpoint = JSON.parse(checkpointRaw);
    const trace = checkpoint?.checkpoint?.channel_values?.trace as AgentTrace | undefined;

    if (!trace) {
      return res.status(404).json({ error: 'No trace in checkpoint' });
    }

    res.json({
      trace: {
        traceId: trace.traceId,
        queryId: trace.queryId,
        query: trace.query,
        outcome: trace.outcome,
        spans: trace.spans,
      },
      metrics: LangSmithUtil.traceToMetadata(trace),
      issues: LangSmithUtil.detectQualityIssues(trace),
      summary: LangSmithUtil.traceSummaryLine(trace),
    });
  } catch (err) {
    console.error('Error in /api/trace:', err);
    res.status(500).json({ error: 'Failed to get trace' });
  }
});

// GET /api/documents - List user's documents
app.get('/api/documents', requireAuth(), async (req, res) => {
  try {
    const { userId: clerkUserId } = getAuth(req);
    if (!clerkUserId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const userId = await getOrCreateUser(clerkUserId);
    const documents = await documentStore.listDocuments(userId);

    res.json({ documents });
  } catch (err) {
    console.error('Error in GET /api/documents:', err);
    res.status(500).json({ error: 'Failed to list documents' });
  }
});

// DELETE /api/documents/:id - Delete a document and its chunks
app.delete('/api/documents/:id', requireAuth(), async (req, res) => {
  try {
    const { userId: clerkUserId } = getAuth(req);
    if (!clerkUserId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const userId = await getOrCreateUser(clerkUserId);
    const docId = req.params.id as string;
    const deleted = await documentStore.deleteDocument(docId, userId);

    if (!deleted) {
      return res.status(404).json({ error: 'Document not found' });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Error in DELETE /api/documents/:id:', err);
    res.status(500).json({ error: 'Failed to delete document' });
  }
});

// SPA fallback - serve index.html for all non-API routes
app.get('/{*splat}', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Start the server
async function main() {
  try {
    await initialize();

    app.listen(PORT, () => {
      console.log(`\nServer running at http://localhost:${PORT}`);
      console.log('Press Ctrl+C to stop.\n');
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

// Handle graceful shutdown
async function gracefulShutdown(signal: string) {
  console.log(`\n${signal} received. Shutting down...`);
  await WorkflowRunStore.releaseAllActiveLocks();
  await shutdownQueues();
  await RedisSessionStore.disconnect();
  await db.destroy();
  process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

main();
