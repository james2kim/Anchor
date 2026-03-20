export interface RateLimitInfo {
  limit: number;
  remaining: number;
}

export interface ChatResponse {
  response: string;
  sessionId?: string;
  quizId?: string;
  workflowData?: unknown;
  rateLimit?: RateLimitInfo;
}

export interface QuizQuestion {
  type: 'multiple_choice' | 'true_false';
  question: string;
  options: string[];
  correctAnswer: string;
  explanation: string;
}

export interface QuizData {
  title: string;
  questions: QuizQuestion[];
}

export interface QuizListItem {
  id: string;
  title: string;
  question_count: number;
  created_at: string;
}

export interface QuizRecord {
  id: string;
  user_id: string;
  title: string;
  quiz_data: QuizData;
  input_data: unknown;
  created_at: string;
}

export interface UploadResponse {
  documentId: string;
  filename: string;
  chunkCount: number;
  title?: string;
}

export interface SignedUrlResponse {
  signedUrl: string;
  fileId: string;
  gcsPath: string;
}

export interface SessionResponse {
  sessionId: string;
  messages: SessionMessage[];
  summary?: string;
}

export interface SessionMessage {
  role?: string;
  content?: string;
  type?: string;
  _getType?: () => string;
  lc_id?: string[];
  text?: string;
}

export const isLocalDev = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

async function getAuthHeaders(getToken: () => Promise<string | null>): Promise<HeadersInit> {
  const token = await getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Safely parse a fetch response as JSON. If the response is not JSON
 * (e.g. Firebase 502 HTML page), throw a user-friendly error.
 */
export async function safeFetchJson<T = Record<string, unknown>>(response: Response): Promise<T> {
  // Detect auth redirects (Clerk redirects to / when token is invalid)
  if (response.redirected || !response.url.includes('/api/')) {
    throw new Error('Session expired — please refresh the page');
  }

  const text = await response.text();

  if (!response.ok) {
    try {
      const data = JSON.parse(text);
      return data as T;
    } catch {
      throw new Error(`Server error (${response.status}) — please try again`);
    }
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    console.error(`[safeFetchJson] Failed to parse response from ${response.url}:`, text.slice(0, 120));
    throw new Error('Unexpected response from server');
  }
}

export interface DocumentItem {
  id: string;
  source: string;
  title: string | null;
  summary: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export async function listDocuments(
  getToken: () => Promise<string | null>
): Promise<DocumentItem[]> {
  const authHeaders = await getAuthHeaders(getToken);

  const response = await fetch('/api/documents', {
    headers: authHeaders,
  });

  if (!response.ok) {
    const data = await safeFetchJson(response);
    throw new Error((data as Record<string, string>).error || 'Failed to list documents');
  }

  const data = await safeFetchJson<{ documents: DocumentItem[] }>(response);
  return data.documents;
}

export async function deleteDocument(
  documentId: string,
  getToken: () => Promise<string | null>
): Promise<void> {
  const authHeaders = await getAuthHeaders(getToken);

  const response = await fetch(`/api/documents/${documentId}`, {
    method: 'DELETE',
    headers: authHeaders,
  });

  if (!response.ok) {
    const data = await safeFetchJson(response);
    throw new Error((data as Record<string, string>).error || 'Failed to delete document');
  }
}

export async function sendMessage(
  message: string,
  getToken: () => Promise<string | null>
): Promise<ChatResponse> {
  const authHeaders = await getAuthHeaders(getToken);

  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders,
    },
    body: JSON.stringify({ message }),
  });

  const rateLimit: RateLimitInfo | undefined = response.headers.get('X-RateLimit-Limit')
    ? {
        limit: Number(response.headers.get('X-RateLimit-Limit')),
        remaining: Number(response.headers.get('X-RateLimit-Remaining')),
      }
    : undefined;

  if (!response.ok) {
    const data = await safeFetchJson(response);
    const err = new Error((data as Record<string, string>).error || 'Failed to send message');
    (err as Error & { rateLimit?: RateLimitInfo }).rateLimit = rateLimit;
    throw err;
  }

  const data = await safeFetchJson<ChatResponse>(response);
  return { ...data, rateLimit };
}

export async function uploadFile(
  file: File,
  getToken: () => Promise<string | null>
): Promise<UploadResponse> {
  const authHeaders = await getAuthHeaders(getToken);
  const formData = new FormData();
  formData.append('file', file);

  const response = await fetch('/api/upload', {
    method: 'POST',
    headers: authHeaders,
    body: formData,
  });

  if (!response.ok) {
    const data = await safeFetchJson(response);
    throw new Error((data as Record<string, string>).error || 'Failed to upload file');
  }

  return safeFetchJson<UploadResponse>(response);
}

const LARGE_FILE_THRESHOLD = 25 * 1024 * 1024; // 25 MB
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB

export async function getSignedUploadUrl(
  file: File,
  getToken: () => Promise<string | null>
): Promise<SignedUrlResponse> {
  const authHeaders = await getAuthHeaders(getToken);

  const response = await fetch('/api/upload/signed-url', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders,
    },
    body: JSON.stringify({
      filename: file.name,
      contentType: file.type,
      fileSize: file.size,
    }),
  });

  if (!response.ok) {
    const data = await safeFetchJson(response);
    throw new Error((data as Record<string, string>).error || 'Failed to get signed URL');
  }

  return safeFetchJson<SignedUrlResponse>(response);
}

export function uploadToGcs(
  file: File,
  signedUrl: string,
  onProgress?: (percent: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', signedUrl, true);
    xhr.setRequestHeader('Content-Type', file.type);

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable && onProgress) {
        onProgress(Math.round((e.loaded / e.total) * 100));
      }
    });

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        reject(new Error(`Upload to storage failed (${xhr.status})`));
      }
    });

    xhr.addEventListener('error', () => reject(new Error('Upload to storage failed')));
    xhr.addEventListener('abort', () => reject(new Error('Upload was cancelled')));

    xhr.send(file);
  });
}

const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

interface JobStatusProgress {
  stage: 'downloading' | 'extracting_text' | 'embedding' | 'summarizing' | 'cleaning_up' | 'completed';
  detail?: string;
}

interface JobStatusResponse {
  status: 'queued' | 'processing' | 'completed' | 'failed';
  result?: UploadResponse;
  error?: string;
  progress?: JobStatusProgress;
}

/**
 * Enqueue a GCS-uploaded file for processing. Returns the jobId immediately.
 */
export async function enqueueFileProcessing(
  params: { fileId: string; gcsPath: string; filename: string },
  getToken: () => Promise<string | null>
): Promise<string> {
  const authHeaders = await getAuthHeaders(getToken);

  const response = await fetch('/api/upload/process', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders,
    },
    body: JSON.stringify(params),
  });

  if (!response.ok) {
    const data = await safeFetchJson(response);
    throw new Error((data as Record<string, string>).error || 'Failed to enqueue file processing');
  }

  const data = await safeFetchJson<{ jobId: string }>(response);
  return data.jobId;
}

/**
 * Poll a queued job until it completes or fails.
 * Calls onProgress with each status update.
 */
export async function pollJobStatus(
  jobId: string,
  getToken: () => Promise<string | null>,
  onProgress?: (status: JobStatusResponse) => void
): Promise<UploadResponse> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

    try {
      const pollHeaders = await getAuthHeaders(getToken);
      const statusRes = await fetch(`/api/upload/status/${jobId}`, {
        headers: pollHeaders,
      });

      if (statusRes.redirected || !statusRes.url.includes('/api/')) {
        continue;
      }

      if (!statusRes.ok) {
        const data = await safeFetchJson(statusRes);
        throw new Error((data as Record<string, string>).error || 'Failed to check processing status');
      }

      const job = await safeFetchJson<JobStatusResponse>(statusRes);
      onProgress?.(job);

      if (job.status === 'completed' && job.result) {
        return job.result;
      }
      if (job.status === 'failed') {
        throw new Error(job.error || 'File processing failed');
      }
      // status === 'processing' or 'queued' → continue polling
    } catch (err) {
      if (err instanceof Error && err.message.includes('Session expired')) {
        continue;
      }
      throw err;
    }
  }

  throw new Error('File processing timed out. Please try again.');
}

export type SmartUploadResult =
  | { kind: 'completed'; result: UploadResponse }
  | { kind: 'enqueued'; jobId: string; filename: string };

/**
 * Upload a file. Returns immediately for queued jobs (large files).
 * Small files are processed synchronously and return the result directly.
 */
export async function uploadFileSmart(
  file: File,
  getToken: () => Promise<string | null>,
  onProgress?: (percent: number) => void
): Promise<SmartUploadResult> {
  if (file.size > MAX_FILE_SIZE) {
    throw new Error('File too large. Maximum size is 100 MB.');
  }

  // Local dev or small files: direct upload (synchronous processing)
  if (isLocalDev || file.size <= LARGE_FILE_THRESHOLD) {
    const result = await uploadFile(file, getToken);
    return { kind: 'completed', result };
  }

  // Large files: upload to GCS → enqueue → return immediately
  const { signedUrl, fileId, gcsPath } = await getSignedUploadUrl(file, getToken);
  await uploadToGcs(file, signedUrl, onProgress);
  const jobId = await enqueueFileProcessing({ fileId, gcsPath, filename: file.name }, getToken);
  return { kind: 'enqueued', jobId, filename: file.name };
}

export async function listQuizzes(
  getToken: () => Promise<string | null>
): Promise<QuizListItem[]> {
  const authHeaders = await getAuthHeaders(getToken);
  const response = await fetch('/api/quizzes', { headers: authHeaders });

  if (!response.ok) {
    const data = await safeFetchJson(response);
    throw new Error((data as Record<string, string>).error || 'Failed to list quizzes');
  }

  const data = await safeFetchJson<{ quizzes: QuizListItem[] }>(response);
  return data.quizzes;
}

export async function getQuiz(
  quizId: string,
  getToken: () => Promise<string | null>
): Promise<QuizRecord> {
  const authHeaders = await getAuthHeaders(getToken);
  const response = await fetch(`/api/quizzes/${quizId}`, { headers: authHeaders });

  if (!response.ok) {
    const data = await safeFetchJson(response);
    throw new Error((data as Record<string, string>).error || 'Failed to get quiz');
  }

  const data = await safeFetchJson<{ quiz: QuizRecord }>(response);
  return data.quiz;
}

export async function deleteQuiz(
  quizId: string,
  getToken: () => Promise<string | null>
): Promise<void> {
  const authHeaders = await getAuthHeaders(getToken);
  const response = await fetch(`/api/quizzes/${quizId}`, {
    method: 'DELETE',
    headers: authHeaders,
  });

  if (!response.ok) {
    const data = await safeFetchJson(response);
    throw new Error((data as Record<string, string>).error || 'Failed to delete quiz');
  }
}

export async function getSession(
  getToken: () => Promise<string | null>
): Promise<SessionResponse | null> {
  const authHeaders = await getAuthHeaders(getToken);

  const response = await fetch('/api/session', {
    headers: authHeaders,
  });

  if (!response.ok) {
    return null;
  }

  return safeFetchJson<SessionResponse>(response);
}

/**
 * Parse session message into a normalized format.
 */
export function parseSessionMessage(msg: SessionMessage): { role: string; content: string } | null {
  let role: string;
  let content: string;

  // LangChain serialized format (has _getType or type field)
  if (msg._getType || msg.type || msg.lc_id) {
    const msgType = msg._getType?.() || msg.type || msg.lc_id?.[2] || '';
    role =
      msgType.includes('human') || msgType === 'user'
        ? 'user'
        : msgType.includes('ai') || msgType === 'assistant'
          ? 'assistant'
          : 'system';
    content = msg.content || msg.text || '';
  }
  // Plain object format
  else {
    role = msg.role === 'user' ? 'user' : msg.role === 'assistant' ? 'assistant' : 'system';
    content = msg.content || '';
  }

  // Handle content that might be an array (LangChain format)
  if (Array.isArray(content)) {
    content = content.map((c) => (typeof c === 'string' ? c : (c as { text?: string }).text || '')).join('');
  }

  if (!content) {
    return null;
  }

  return { role, content };
}
