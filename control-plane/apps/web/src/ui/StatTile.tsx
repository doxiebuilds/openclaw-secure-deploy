import type { ReactNode } from 'react';
import { Card } from './Card';

export function StatTile({
  label,
  value,
  hint,
  icon,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <Card>
      <div className="flex items-start justify-between">
        <div className="text-13px text-ink-2 font-medium">{label}</div>
        {icon ? <div className="text-ink-3">{icon}</div> : null}
      </div>
      <div className="text-28px font-semibold text-ink mt-4px leading-tight">{value}</div>
      {hint ? <div className="text-13px text-ink-2 mt-6px">{hint}</div> : null}
    </Card>
  );
}
