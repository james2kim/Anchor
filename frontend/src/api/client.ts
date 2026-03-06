export interface RateLimitInfo {
  limit: number;
  remaining: number;
}

export interface ChatResponse {
  response: string;
  sessionId?: string;
  rateLimit?: RateLimitInfo;
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

interface JobStatusResponse {
  status: 'processing' | 'completed' | 'failed';
  result?: UploadResponse;
  error?: string;
}

export async function processUploadedFile(
  params: { fileId: string; gcsPath: string; filename: string },
  getToken: () => Promise<string | null>,
  onProcessing?: () => void
): Promise<UploadResponse> {
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
    throw new Error((data as Record<string, string>).error || 'Failed to process uploaded file');
  }

  const data = await safeFetchJson<UploadResponse & { jobId?: string; status?: string }>(response);

  // Dev mode: backend returns the result directly (synchronous)
  if (!data.jobId) {
    return data as UploadResponse;
  }

  // Production mode: backend returned { jobId, status: 'processing' }, poll for result
  const { jobId } = data;
  onProcessing?.();

  const deadline = Date.now() + POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

    try {
      const pollHeaders = await getAuthHeaders(getToken);
      const statusRes = await fetch(`/api/upload/status/${jobId}`, {
        headers: pollHeaders,
      });

      // Auth redirect or non-API response — token probably expired, retry next poll
      if (statusRes.redirected || !statusRes.url.includes('/api/')) {
        continue;
      }

      if (!statusRes.ok) {
        const data = await safeFetchJson(statusRes);
        throw new Error((data as Record<string, string>).error || 'Failed to check processing status');
      }

      const job = await safeFetchJson<JobStatusResponse>(statusRes);

      if (job.status === 'completed' && job.result) {
        return job.result;
      }
      if (job.status === 'failed') {
        throw new Error(job.error || 'File processing failed');
      }
      // status === 'processing' → continue polling
    } catch (err) {
      // Auth errors during polling — token will refresh on next iteration
      if (err instanceof Error && err.message.includes('Session expired')) {
        continue;
      }
      throw err;
    }
  }

  throw new Error('File processing timed out. Please try again.');
}

export async function uploadFileSmart(
  file: File,
  getToken: () => Promise<string | null>,
  onProgress?: (percent: number) => void,
  onProcessing?: () => void
): Promise<UploadResponse> {
  if (file.size > MAX_FILE_SIZE) {
    throw new Error('File too large. Maximum size is 100 MB.');
  }

  // Local dev: always use direct upload (no GCS credentials locally)
  // Production small files: also use direct upload
  if (isLocalDev || file.size <= LARGE_FILE_THRESHOLD) {
    return uploadFile(file, getToken);
  }

  // Production large files: use signed URL → GCS → async processing
  const { signedUrl, fileId, gcsPath } = await getSignedUploadUrl(file, getToken);
  await uploadToGcs(file, signedUrl, onProgress);
  return processUploadedFile({ fileId, gcsPath, filename: file.name }, getToken, onProcessing);
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
