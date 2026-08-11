import type { ReactNode } from 'react';

export function EmptyState({
  title = 'Nothing here yet',
  description,
  action,
  icon,
}: {
  title?: string;
  description?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-40px px-20px gap-8px">
      {icon ? <div className="text-ink-3 text-24px mb-4px">{icon}</div> : null}
      <div className="text-14px font-medium text-ink">{title}</div>
      {description ? <div className="text-13px text-ink-2 max-w-360px">{description}</div> : null}
      {action ? <div className="mt-8px">{action}</div> : null}
    </div>
  );
}
