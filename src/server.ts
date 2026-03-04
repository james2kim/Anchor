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

import { PDFLoader } from '@langchain/community/document_loaders/fs/pdf';
import { DocxLoader } from '@langchain/community/document_loaders/fs/docx';

import { RedisSessionStore } from './stores/RedisSessionStore';
import { RedisCheckpointer } from './memory/RedisCheckpointer';
import { UserStore } from './stores/UserStore';
import { buildWorkflow } from './agent/graph';
import { ingestDocument } from './ingest/ingestDocument';
import { DocumentStore } from './stores/DocumentStore';
import { db } from './db/knex';
import { runBackgroundSummarization, runBackgroundExtraction } from './agent/backgroundTasks';
import { MAX_MESSAGES } from './agent/constants';
import { LangSmithUtil } from './util/LangSmithUtil';
import { TitleExtractor } from './util/TitleExtractor';
import type { AgentTrace } from './schemas/types';

// Supported file types
const SUPPORTED_EXTENSIONS = ['.pdf', '.docx', '.doc', '.md', '.txt'];
const SUPPORTED_MIMETYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  'text/markdown',
  'text/plain',
];

// Convert Node.js Buffer to Blob
function bufferToBlob(buffer: Buffer, type: string): Blob {
  // Create a Uint8Array view of the buffer to use as BlobPart
  const uint8Array = new Uint8Array(buffer);
  return new Blob([uint8Array], { type });
}

type ExtractedContent = {
  text: string;
  pdfTitle?: string; // Title from PDF metadata if available
};

// Extract text from uploaded file using LangChain loaders
async function extractTextFromFile(
  buffer: Buffer,
  originalname: string,
  mimetype: string
): Promise<ExtractedContent> {
  const ext = path.extname(originalname).toLowerCase();

  // PDF files
  if (ext === '.pdf' || mimetype === 'application/pdf') {
    const blob = bufferToBlob(buffer, 'application/pdf');
    const loader = new PDFLoader(blob, { splitPages: false });
    const docs = await loader.load();
    const text = docs.map((doc) => doc.pageContent).join('\n\n');

    // Try to get title from PDF metadata
    const pdfTitle = docs[0]?.metadata?.pdf?.info?.Title as string | undefined;

    return { text, pdfTitle };
  }

  // Word documents (.docx)
  if (
    ext === '.docx' ||
    mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ) {
    const blob = bufferToBlob(
      buffer,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    );
    const loader = new DocxLoader(blob);
    const docs = await loader.load();
    return { text: docs.map((doc) => doc.pageContent).join('\n\n') };
  }

  // Legacy .doc files - try DocxLoader (may not work for all .doc files)
  if (ext === '.doc' || mimetype === 'application/msword') {
    const blob = bufferToBlob(buffer, 'application/msword');
    const loader = new DocxLoader(blob);
    const docs = await loader.load();
    return { text: docs.map((doc) => doc.pageContent).join('\n\n') };
  }

  // Markdown and plain text files
  if (
    ext === '.md' ||
    ext === '.txt' ||
    mimetype === 'text/markdown' ||
    mimetype === 'text/plain'
  ) {
    return { text: buffer.toString('utf-8') };
  }

  throw new Error(`Unsupported file type: ${ext || mimetype}`);
}

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
        connectSrc: ["'self'", 'https://*.clerk.accounts.dev'],
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

// Configure multer for file uploads (10 MB limit)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

// Rate limiting (production only)
const DAILY_CHAT_LIMIT = 40;
const RATE_LIMIT_TTL = 86400; // 24 hours in seconds

async function checkRateLimit(userId: string): Promise<{ allowed: boolean; remaining: number }> {
  if (!isProduction) return { allowed: true, remaining: DAILY_CHAT_LIMIT };

  const key = `ratelimit:chat:${userId}`;
  const client = RedisSessionStore.getClient();

  const count = await client.incr(key);

  // Set TTL on first request of the window
  if (count === 1) {
    await client.expire(key, RATE_LIMIT_TTL);
  }

  const remaining = Math.max(0, DAILY_CHAT_LIMIT - count);
  return { allowed: count <= DAILY_CHAT_LIMIT, remaining };
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
app.post('/api/upload', requireAuth(), upload.single('file'), async (req, res) => {
  try {
    const { userId: clerkUserId } = getAuth(req);
    if (!clerkUserId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const userId = await getOrCreateUser(clerkUserId);

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
  } catch (err) {
    console.error('Error in /api/upload:', err);
    const message = err instanceof Error ? err.message : 'Failed to process upload';
    res.status(500).json({ error: message });
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
process.on('SIGINT', async () => {
  console.log('\nShutting down...');
  await RedisSessionStore.disconnect();
  await db.destroy();
  process.exit(0);
});

main();
