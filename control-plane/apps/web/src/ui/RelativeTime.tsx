import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';

dayjs.extend(relativeTime);

export function RelativeTime({ value, prefix }: { value: string | number | null | undefined; prefix?: string }) {
  if (value == null) return <span className="text-ink-3">—</span>;
  const d = dayjs(value);
  if (!d.isValid()) return <span className="text-ink-3">—</span>;
  return (
    <time dateTime={d.toISOString()} title={d.format('YYYY-MM-DD HH:mm:ss')} className="text-ink-2">
      {prefix}
      {d.fromNow()}
    </time>
  );
}
