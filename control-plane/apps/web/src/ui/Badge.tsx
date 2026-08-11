import classNames from 'classnames';
import type { ReactNode } from 'react';

export type Tone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'muted';

const toneClass: Record<Tone, string> = {
  neutral: 'text-ink border-edge bg-panel',
  primary: 'text-accent border-[var(--ocp-accent-edge)] bg-[var(--ocp-accent-soft)]',
  success: 'text-ok border-[var(--ocp-ok-edge)] bg-[var(--ocp-ok-soft)]',
  warning: 'text-warn border-[var(--ocp-warn-edge)] bg-[var(--ocp-warn-soft)]',
  danger: 'text-bad border-[var(--ocp-bad-edge)] bg-[var(--ocp-bad-soft)]',
  muted: 'text-ink-3 border-edge bg-canvas',
};

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span
      className={classNames(
        'inline-flex items-center gap-6px rd-full border px-10px py-3px text-12px font-medium leading-none',
        toneClass[tone]
      )}
    >
      {children}
    </span>
  );
}

const HEALTH_TONE: Record<string, Tone> = {
  online: 'success',
  degraded: 'warning',
  offline: 'danger',
  unknown: 'muted',
};

const HEALTH_LABEL: Record<string, string> = {
  online: 'Online',
  degraded: 'Degraded',
  offline: 'Offline',
  unknown: 'Not checked',
};

/**
 * "offline" (unreachable, we tried) and "unknown" (never probed) are
 * distinct states operationally — they used to render identically.
 */
export function StatusBadge({ status }: { status: string }) {
  const tone = HEALTH_TONE[status] ?? 'muted';
  const label = HEALTH_LABEL[status] ?? status;
  return (
    <Badge tone={tone}>
      <StatusDot tone={tone} />
      {label}
    </Badge>
  );
}

export function StatusDot({ tone = 'neutral' }: { tone?: Tone }) {
  const dot: Record<Tone, string> = {
    neutral: 'bg-ink-3',
    primary: 'bg-accent',
    success: 'bg-ok',
    warning: 'bg-warn',
    danger: 'bg-bad',
    muted: 'bg-ink-disabled',
  };
  return <span className={classNames('inline-block size-6px rd-full', dot[tone])} />;
}
