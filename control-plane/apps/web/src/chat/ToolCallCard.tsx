import classNames from 'classnames';
import { Icon } from '../ui';
import type { Tone } from '../ui/Badge';
import { RelativeTime } from '../ui/RelativeTime';

export type TimelineEvent = {
  id: string;
  ts: number | null;
  role: string | null;
  kind: string;
  summary: string;
};

const KIND_TONE: Record<string, Tone> = {
  tool: 'warning',
  user: 'primary',
  error: 'danger',
  ok: 'success',
};

function KindIcon({ kind }: { kind: string }) {
  if (kind === 'tool') return <Icon.Terminal size={13} />;
  if (kind === 'user') return <Icon.User size={13} />;
  if (kind === 'error') return <Icon.Attention size={13} />;
  return <Icon.Check size={13} />;
}

export function ToolCallCard({ event }: { event: TimelineEvent }) {
  const tone = KIND_TONE[event.kind] ?? 'neutral';
  return (
    <div className="flex gap-10px mb-10px">
      <div
        className={classNames(
          'shrink-0 size-24px rd-full ocp-center mt-2px',
          tone === 'warning' && 'bg-[var(--ocp-warn-soft)] text-warn',
          tone === 'primary' && 'bg-[var(--ocp-accent-soft)] text-accent',
          tone === 'danger' && 'bg-[var(--ocp-bad-soft)] text-bad',
          tone === 'success' && 'bg-[var(--ocp-ok-soft)] text-ok',
          tone === 'neutral' && 'bg-panel text-ink-3'
        )}
      >
        <KindIcon kind={event.kind} />
      </div>
      <div className="flex-1 min-w-0 border border-edge rd-10px px-12px py-8px bg-canvas">
        <div className="flex items-center gap-8px text-12px text-ink-3 mb-2px">
          <span className="uppercase tracking-wide font-medium">{event.kind}</span>
          {event.role ? <span>· {event.role}</span> : null}
          {event.ts ? <RelativeTime value={event.ts} /> : null}
        </div>
        <div className="text-13px text-ink whitespace-pre-wrap break-words font-mono">{event.summary}</div>
      </div>
    </div>
  );
}
