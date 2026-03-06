import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Inline copy of safeFetchJson from frontend/src/api/client.ts.
 * Imported inline to avoid cross-project rootDir issues with tsc.
 * The canonical implementation lives in the frontend and is exported there.
 */
async function safeFetchJson<T = Record<string, unknown>>(response: Response): Promise<T> {
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

/** Create a minimal Response-like object for testing safeFetchJson. */
function createMockResponse(opts: {
  body: string;
  status?: number;
  ok?: boolean;
  redirected?: boolean;
  url?: string;
}): Response {
  const status = opts.status ?? 200;
  return {
    text: async () => opts.body,
    ok: opts.ok ?? (status >= 200 && status < 300),
    status,
    redirected: opts.redirected ?? false,
    url: opts.url ?? 'https://app.example.com/api/test',
  } as unknown as Response;
}

describe('safeFetchJson', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns parsed JSON for a successful response', async () => {
    const res = createMockResponse({ body: '{"message":"ok"}' });
    const data = await safeFetchJson(res);
    expect(data).toEqual({ message: 'ok' });
  });

  it('throws "Unexpected response from server" when OK response has HTML body', async () => {
    const res = createMockResponse({ body: '<!DOCTYPE html><html><body>Bad Gateway</body></html>' });
    await expect(safeFetchJson(res)).rejects.toThrow('Unexpected response from server');
  });

  it('throws "Session expired" when response.redirected is true', async () => {
    const res = createMockResponse({
      body: '',
      redirected: true,
      url: 'https://app.example.com/api/chat',
    });
    await expect(safeFetchJson(res)).rejects.toThrow('Session expired');
  });

  it('throws "Session expired" when URL does not contain /api/', async () => {
    const res = createMockResponse({
      body: '{}',
      url: 'https://app.example.com/sign-in',
    });
    await expect(safeFetchJson(res)).rejects.toThrow('Session expired');
  });

  it('returns parsed error JSON for non-OK response with JSON body', async () => {
    const res = createMockResponse({
      body: '{"error":"rate limited"}',
      status: 500,
      ok: false,
      url: 'https://app.example.com/api/chat',
    });
    const data = await safeFetchJson(res);
    expect(data).toEqual({ error: 'rate limited' });
  });

  it('throws "Server error (502)" for non-OK response with HTML body', async () => {
    const res = createMockResponse({
      body: '<!DOCTYPE html><html>502 Bad Gateway</html>',
      status: 502,
      ok: false,
      url: 'https://app.example.com/api/chat',
    });
    await expect(safeFetchJson(res)).rejects.toThrow('Server error (502)');
  });
});
