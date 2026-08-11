const TOKEN_KEY = 'ocp_token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null) {
  if (!token) localStorage.removeItem(TOKEN_KEY);
  else localStorage.setItem(TOKEN_KEY, token);
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * In-flight GETs, keyed by path.
 *
 * Several components mount at once and ask for the same expensive endpoint, and
 * React StrictMode fires every mount effect twice in dev. Sharing the pending
 * promise collapses those into one request; it is not a response cache, so the
 * entry is dropped as soon as the request settles.
 */
const inFlight = new Map<string, Promise<unknown>>();

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase();
  if (method !== 'GET') return request<T>(path, init);

  const existing = inFlight.get(path);
  if (existing) return existing as Promise<T>;

  const pending = request<T>(path, init).finally(() => {
    inFlight.delete(path);
  });
  inFlight.set(path, pending);
  return pending;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (!headers.has('Content-Type') && init.body) {
    headers.set('Content-Type', 'application/json');
  }
  const token = getToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);

  let res: Response;
  try {
    res = await fetch(path, { ...init, headers });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ApiError(
      `Cannot reach control-plane API (is it running on :8787?). ${detail}`,
      0,
      'api_unreachable'
    );
  }

  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text };
    }
  }
  if (!res.ok) {
    const body = (data || {}) as { error?: string; code?: string };
    // Vite returns a plain "Internal Server Error" / HTML when the API proxy target is down.
    if (
      res.status === 500 &&
      (typeof body.error === 'string'
        ? /internal server error/i.test(body.error) || body.error.trim() === ''
        : true) &&
      (!text || /internal server error/i.test(text) || text.trim() === '')
    ) {
      throw new ApiError(
        'Control-plane API is not reachable on http://127.0.0.1:8787. Start it with: npm run dev:api',
        500,
        'api_unreachable'
      );
    }
    const message =
      (typeof body.error === 'string' && body.error) ||
      (text && !text.startsWith('<') ? text.slice(0, 200) : null) ||
      res.statusText ||
      'Request failed';
    throw new ApiError(message, res.status, body.code);
  }
  return data as T;
}
