import { getToken } from '../api';

export type ConnectionState = 'connecting' | 'connected' | 'offline';

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 20000;

export type SseHandlers = {
  onEvent: (event: string, data: string) => void;
  onState?: (state: ConnectionState) => void;
};

/**
 * Consume a Bearer-authenticated SSE endpoint, reconnecting with backoff.
 *
 * The native EventSource API cannot send an Authorization header, so the
 * text/event-stream response is read via fetch() and framed by hand
 * (event:/data:/blank-line). Returns a cancel function.
 */
export function consumeSse(url: string, handlers: SseHandlers): () => void {
  let cancelled = false;
  let controller: AbortController | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;

  function handleFrame(frame: string) {
    let event = 'message';
    const dataLines: string[] = [];
    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length === 0) return;
    handlers.onEvent(event, dataLines.join('\n'));
  }

  async function connect() {
    if (cancelled) return;
    handlers.onState?.('connecting');
    controller = new AbortController();
    try {
      const token = getToken();
      const res = await fetch(url, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: controller.signal,
      });
      if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);

      attempt = 0;
      handlers.onState?.('connected');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (!cancelled) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let sepIndex: number;
        while ((sepIndex = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, sepIndex);
          buffer = buffer.slice(sepIndex + 2);
          handleFrame(frame);
        }
      }
      throw new Error('stream closed');
    } catch (err) {
      if (cancelled || (err instanceof Error && err.name === 'AbortError')) return;
      handlers.onState?.('offline');
      attempt += 1;
      const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** (attempt - 1));
      reconnectTimer = setTimeout(connect, delay);
    }
  }

  void connect();

  return () => {
    cancelled = true;
    controller?.abort();
    if (reconnectTimer) clearTimeout(reconnectTimer);
  };
}
