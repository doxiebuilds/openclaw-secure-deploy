import { useEffect, useState } from 'react';
import { consumeSse, type ConnectionState } from './sseClient';

/**
 * Live transcript for one session.
 *
 * Replaces a 4s SWR poll. The server holds the gateway's own event feed, so an
 * agent's reply reaches the UI when the gateway emits it rather than on the
 * next tick of a timer — and an idle conversation costs no traffic at all.
 *
 * The first `detail` frame arrives immediately on subscribe (the server pushes
 * whatever it has cached), so this doubles as the initial load.
 */
export function useSessionStream<T>(
  gatewayId: string,
  sessionKey: string,
  limit = 80
): { detail: T | null; state: ConnectionState } {
  const [detail, setDetail] = useState<T | null>(null);
  const [state, setState] = useState<ConnectionState>('connecting');

  useEffect(() => {
    // Drop the previous conversation's transcript immediately; rendering it
    // under a new session key would show the wrong messages until the first
    // frame lands.
    setDetail(null);
    if (!gatewayId || !sessionKey) return;

    const url = `/api/gateways/${gatewayId}/sessions/${encodeURIComponent(
      sessionKey
    )}/stream?limit=${limit}`;

    // The server already drops frames that say nothing new; this catches the
    // one it cannot — a reconnect replays the current transcript, and swapping
    // in an identical-but-new object would re-render the whole list and jolt
    // the reader's scroll position for nothing.
    let lastFrame: string | null = null;

    return consumeSse(url, {
      onState: setState,
      onEvent: (event, data) => {
        if (event !== 'detail') return;
        if (data === lastFrame) return;
        lastFrame = data;
        try {
          setDetail(JSON.parse(data) as T);
        } catch {
          // ignore malformed frame
        }
      },
    });
  }, [gatewayId, sessionKey, limit]);

  return { detail, state };
}
