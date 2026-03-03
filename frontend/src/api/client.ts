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

async function getAuthHeaders(getToken: () => Promise<string | null>): Promise<HeadersInit> {
  const token = await getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
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
    const data = await response.json();
    const err = new Error(data.error || 'Failed to send message');
    (err as Error & { rateLimit?: RateLimitInfo }).rateLimit = rateLimit;
    throw err;
  }

  const data = await response.json();
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
    const data = await response.json();
    throw new Error(data.error || 'Failed to upload file');
  }

  return response.json();
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

  return response.json();
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
