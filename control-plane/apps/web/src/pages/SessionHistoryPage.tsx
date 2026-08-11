import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { mutate } from 'swr';
import { api } from '../api';
import { MessageList } from '../chat/MessageList';
import { TimelineList } from '../chat/TimelineList';
import { Composer } from '../chat/Composer';
import type { ChatMessage } from '../chat/MessageBubble';
import type { TimelineEvent } from '../chat/ToolCallCard';
import { useSessionStream } from '../realtime/useSessionStream';
import { Icon, Tabs } from '../ui';
import { SkeletonRows } from '../ui/Skeleton';
import { toast } from '../ui/toast';

type SessionDetail = {
  gatewayId: string;
  sessionKey: string;
  /** Operator-facing name, derived from the opening message or set by hand. */
  title: string;
  history: { messages?: ChatMessage[]; sessionId?: string } | null;
  timeline: TimelineEvent[];
  historyError: string | null;
  projectedAt: string;
};

type SendResult = {
  result: { runId: string | null; status: string | null };
};

/** Local echo of a sent message, held until the server transcript contains it. */
type PendingMessage = { id: string; message: ChatMessage };

export function SessionHistoryPage() {
  const { id = '', sessionKey: rawKey = '' } = useParams();
  const sessionKey = decodeURIComponent(rawKey);
  const [view, setView] = useState<'messages' | 'timeline'>('messages');
  const [pending, setPending] = useState<PendingMessage[]>([]);
  const [renamed, setRenamed] = useState<string | null>(null);
  const { detail, state } = useSessionStream<SessionDetail>(id, sessionKey);

  useEffect(() => {
    setPending([]);
    setRenamed(null);
  }, [id, sessionKey]);

  const renameLocally = useCallback(
    (title: string) => {
      setRenamed(title);
      // The sidebar reads titles from the session list, not the stream.
      void mutate(`/api/gateways/${id}/sessions`);
    },
    [id]
  );

  // Once the server agrees, stop shadowing it — otherwise a rename made in
  // another tab would never reach this one.
  useEffect(() => {
    if (renamed !== null && detail?.title === renamed) setRenamed(null);
  }, [detail?.title, renamed]);

  const messages = detail?.history?.messages ?? [];
  const timeline = detail?.timeline ?? [];

  /**
   * Retire local echoes the server transcript has caught up on.
   *
   * Matching on content rather than identity: the gateway assigns its own ids,
   * so the echo and the real message have nothing in common but their text.
   * Without this the user would briefly see their message twice.
   */
  useEffect(() => {
    if (pending.length === 0) return;

    setPending((prev) => {
      const serverTexts = messages
        .filter((m) => m.role === 'user')
        .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)));
      if (serverTexts.length === 0) return prev;

      const next = prev.filter((p) => {
        const text =
          typeof p.message.content === 'string'
            ? p.message.content
            : JSON.stringify(p.message.content);
        const index = serverTexts.indexOf(text);
        if (index === -1) return true;
        // Consume the match so two identical messages retire one echo each.
        serverTexts.splice(index, 1);
        return false;
      });

      // Returning `prev` unchanged is load-bearing: `detail` is a fresh object
      // on every stream frame, so an unconditional new array here would make
      // this effect re-trigger itself forever.
      return next.length === prev.length ? prev : next;
    });
  }, [detail, pending.length, messages]);

  const sendMessage = useCallback(
    async (text: string) => {
      const echo: PendingMessage = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        message: { role: 'user', content: text },
      };
      // Render before the request: the composer must never feel gated on a
      // round trip, and the stream will reconcile this within a few hundred ms.
      setPending((p) => [...p, echo]);

      try {
        const res = await api<SendResult>(
          `/api/gateways/${id}/sessions/${encodeURIComponent(sessionKey)}/messages`,
          { method: 'POST', body: JSON.stringify({ message: text }) }
        );
        toast.success(`Sent · run ${res.result.runId ?? '—'} · ${res.result.status ?? 'started'}`);
        // No refetch here: the server pushes the updated transcript over the
        // stream, and the echo retires when it arrives.
      } catch (err) {
        setPending((p) => p.filter((m) => m.id !== echo.id));
        toast.error(err instanceof Error ? err.message : String(err));
      }
    },
    [id, sessionKey]
  );

  const showInitialLoading = detail === null && state !== 'offline';
  const pendingMessages = pending.map((p) => p.message);

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center justify-between gap-16px px-24px pt-16px pb-10px border-b border-edge shrink-0">
        <div className="min-w-0">
          <SessionTitle
            gatewayId={id}
            sessionKey={sessionKey}
            title={renamed ?? detail?.title ?? ''}
            onRenamed={renameLocally}
          />
          {state === 'offline' ? (
            <div className="text-13px text-bad mt-2px">
              Live updates disconnected — reconnecting…
            </div>
          ) : detail?.historyError ? (
            <div className="text-13px text-bad mt-2px">{detail.historyError}</div>
          ) : (
            <div className="text-12px font-mono text-ink-3 truncate" title={sessionKey}>
              {sessionKey}
            </div>
          )}
        </div>
        <Tabs
          active={view}
          onChange={(k) => setView(k as 'messages' | 'timeline')}
          items={[
            { key: 'messages', label: 'Messages' },
            { key: 'timeline', label: 'Timeline' },
          ]}
        />
      </div>

      <div className="flex-1 min-h-0 px-24px pt-12px overflow-hidden flex flex-col">
        {showInitialLoading ? (
          <div className="max-w-860px mx-auto w-full pt-8px">
            <SkeletonRows rows={5} />
          </div>
        ) : view === 'messages' ? (
          <MessageList messages={[...messages, ...pendingMessages]} />
        ) : (
          <TimelineList events={timeline} />
        )}
      </div>

      <div className="px-24px shrink-0">
        <Composer onSend={sendMessage} />
      </div>
    </div>
  );
}

/**
 * The conversation's name, editable in place.
 *
 * The Gateway has no rename RPC and labels every session it opened for us with
 * our own client name, so the name shown here is control-plane state: derived
 * from the opening message on send, and overridable here.
 */
function SessionTitle({
  gatewayId,
  sessionKey,
  title,
  onRenamed,
}: {
  gatewayId: string;
  sessionKey: string;
  title: string;
  onRenamed: (title: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  function open() {
    setDraft(title);
    setEditing(true);
  }

  async function commit() {
    setEditing(false);
    const next = draft.trim();
    if (!next || next === title) return;
    // Shown immediately: a rename the operator just typed should not appear to
    // fail for the length of a round trip.
    onRenamed(next);
    try {
      const res = await api<{ title: string }>(
        `/api/gateways/${gatewayId}/sessions/${encodeURIComponent(sessionKey)}/title`,
        { method: 'PUT', body: JSON.stringify({ title: next }) }
      );
      onRenamed(res.title);
    } catch (err) {
      onRenamed(title);
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        autoFocus
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void commit();
          if (e.key === 'Escape') setEditing(false);
        }}
        aria-label="Session name"
        className="w-320px max-w-full text-15px font-semibold text-ink bg-raised border border-[var(--ocp-accent-edge)] rd-8px px-8px py-3px outline-none"
      />
    );
  }

  return (
    <button
      type="button"
      onClick={open}
      title="Rename this conversation"
      className="group flex items-center gap-6px max-w-560px text-left px-8px py-3px -ml-8px rd-8px hover:bg-hover transition-colors duration-120"
    >
      <span className="text-15px font-semibold text-ink truncate">{title || 'Untitled session'}</span>
      <Icon.Edit
        size={13}
        className="shrink-0 text-ink-3 opacity-0 group-hover:opacity-100 transition-opacity duration-120"
      />
    </button>
  );
}
