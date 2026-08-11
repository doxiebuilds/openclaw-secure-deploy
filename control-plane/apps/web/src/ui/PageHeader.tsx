import type { ReactNode } from 'react';

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-16px mb-20px flex-wrap">
      <div>
        <h1 className="m-0 mb-6px text-22px font-semibold text-ink">{title}</h1>
        {subtitle ? <p className="m-0 text-14px text-ink-2">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-8px flex-wrap">{actions}</div> : null}
    </div>
  );
}
