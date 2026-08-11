import useSWR from 'swr';
import { useState } from 'react';
import classNames from 'classnames';
import { NavLink, useNavigate, useParams } from 'react-router-dom';
import { Icon, StatusDot } from '../ui';
import type { Tone } from '../ui/Badge';
import { api } from '../api';
import { toast } from '../ui/toast';

type GatewayRow = {
  id: string;
  role: string;
  live: { status: string } | null;
};

type SessionRow = {
  key: string;
  agentId: string | null;
  updatedAt: number | null;
  kind: string | null;
  displayName?: string | null;
  /** Control-plane name: derived from the opening message, or set by hand. */
  title?: string | null;
};

type AgentRow = { id: string; isDefault: boolean };

const HEALTH_TONE: Record<string, Tone> = {
  online: 'success',
  degraded: 'warning',
  offline: 'danger',
  unknown: 'muted',
};

/**
 * `title` is what the API resolved for this session; `displayName` is whatever
 * the gateway had, which for anything opened from here is the name of this
 * client — identical on every row, and so useless as a label.
 */
function sessionLabel(s: SessionRow): string {
  const raw = s.title || s.key;
  return raw.length > 34 ? `${raw.slice(0, 34)}…` : raw;
}

/**
 * There is no `sessions.create` RPC on the gateway — chat.send takes an
 * arbitrary sessionKey and the gateway is expected to create the session on
 * first use, the same way `agent:<agentId>:<sessionId>` keys already look in
 * fleet fixtures. This mints a key in that shape and navigates to it; the
 * session becomes real once the first message actually sends.
 */
function mintSessionKey(agentId: string): string {
  return `agent:${agentId}:${crypto.randomUUID()}`;
}

function GatewayNode({ gateway, defaultOpen }: { gateway: GatewayRow; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();
  const { data } = useSWR<{ items: SessionRow[] }>(open ? `/api/gateways/${gateway.id}/sessions` : null);
  const sessions = (data?.items ?? []).slice(0, 12);

  async function startNewSession(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setCreating(true);
    try {
      const res = await api<{ items: AgentRow[] }>(`/api/gateways/${gateway.id}/agents`);
      const agent = res.items.find((a) => a.isDefault) ?? res.items[0];
      if (!agent) {
        toast.error(`No agents available on ${gateway.id}`);
        return;
      }
      const key = mintSessionKey(agent.id);
      setOpen(true);
      navigate(`/gateways/${gateway.id}/sessions/${encodeURIComponent(key)}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }

  return (
    <div>
      <div className="w-full flex items-center gap-6px rd-9px hover:bg-hover transition-colors duration-150 group">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex-1 flex items-center gap-8px px-8px py-7px text-13px text-ink min-w-0"
        >
          <Icon.Down size={11} className={classNames('transition-transform duration-150 text-ink-3 shrink-0', !open && '-rotate-90')} />
          <StatusDot tone={HEALTH_TONE[gateway.live?.status ?? 'unknown']} />
          <span className="font-medium capitalize flex-1 text-left truncate">{gateway.id}</span>
        </button>
        <button
          type="button"
          onClick={(e) => void startNewSession(e)}
          disabled={creating}
          aria-label={`New session on ${gateway.id}`}
          title="New session"
          className="shrink-0 ocp-center size-22px mr-6px rd-7px text-ink-2 hover:bg-press hover:text-ink transition-colors duration-150 disabled:opacity-50"
        >
          <Icon.Add size={13} />
        </button>
      </div>
      {open ? (
        <div className="ml-24px flex flex-col gap-1px mt-2px mb-4px">
          <NavLink
            to={`/gateways/${gateway.id}`}
            className={({ isActive }) =>
              classNames(
                'block px-8px py-6px rd-8px text-13px transition-colors duration-150',
                isActive ? 'bg-press text-ink' : 'text-ink-2 hover:bg-hover hover:text-ink'
              )
            }
          >
            Overview
          </NavLink>
          {sessions.length === 0 ? (
            <div className="px-8px py-6px text-12px text-ink-3">No sessions yet</div>
          ) : (
            sessions.map((s) => (
              <NavLink
                key={s.key}
                to={`/gateways/${gateway.id}/sessions/${encodeURIComponent(s.key)}`}
                title={s.key}
                className={({ isActive }) =>
                  classNames(
                    'flex items-center gap-6px px-8px py-6px rd-8px text-13px transition-colors duration-150',
                    isActive ? 'bg-press text-ink' : 'text-ink-2 hover:bg-hover hover:text-ink'
                  )
                }
              >
                <Icon.Terminal size={13} className="shrink-0 text-ink-3" />
                <span className="truncate">{sessionLabel(s)}</span>
              </NavLink>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

export function FleetTree() {
  const { data } = useSWR<{ items: GatewayRow[] }>('/api/gateways');
  const params = useParams();
  const items = data?.items ?? [];

  return (
    <div className="flex flex-col gap-2px px-8px">
      {items.map((g) => (
        <GatewayNode key={g.id} gateway={g} defaultOpen={params.id === g.id} />
      ))}
    </div>
  );
}
