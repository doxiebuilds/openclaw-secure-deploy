import useSWR from 'swr';
import { Card, PageHeader, PageLoading, Badge, Button, Icon, RelativeTime } from '../ui';

type DirStats = {
  name: string;
  path: string;
  exists: boolean;
  fileCount: number;
  newestMtimeMs: number | null;
  sampleNames: string[];
};

export function ExchangePage() {
  const { data, error, mutate, isLoading } = useSWR<{ dirs: DirStats[]; projectedAt: string }>('/api/exchange', {
    refreshInterval: 30_000,
  });

  if (isLoading && !data) return <PageLoading />;
  const dirs = data?.dirs ?? [];

  return (
    <div>
      <PageHeader
        title="Exchange"
        subtitle="Read-only view of the air-gapped cross-cell handoff directories."
        actions={
          <Button icon={<Icon.Refresh size={14} />} onClick={() => void mutate()}>
            Refresh
          </Button>
        }
      />
      {error ? (
        <div className="mb-16px px-12px py-10px rd-10px text-13px text-bad bg-[var(--ocp-bad-soft)] border border-[var(--ocp-bad-edge)]">
          {error instanceof Error ? error.message : String(error)}
        </div>
      ) : null}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-14px">
        {dirs.map((d) => (
          <Card key={d.name}>
            <div className="flex items-center justify-between mb-6px">
              <h3 className="m-0 text-15px font-semibold flex items-center gap-6px">
                <Icon.Folder size={15} className="text-ink-3" />
                {d.name}
              </h3>
              <Badge tone={d.exists ? 'success' : 'danger'}>{d.exists ? `${d.fileCount} files` : 'missing'}</Badge>
            </div>
            <div className="font-mono text-12px text-ink-3 truncate">{d.path}</div>
            {d.newestMtimeMs ? (
              <div className="text-13px text-ink-2 mt-6px">
                Newest <RelativeTime value={d.newestMtimeMs} />
              </div>
            ) : null}
            {d.sampleNames.length ? (
              <ul className="mt-8px pl-18px">
                {d.sampleNames.map((n) => (
                  <li key={n} className="font-mono text-12px text-ink-3 truncate">
                    {n}
                  </li>
                ))}
              </ul>
            ) : (
              <div className="text-13px text-ink-3 mt-10px">Empty</div>
            )}
          </Card>
        ))}
      </div>
      {data?.projectedAt ? (
        <p className="text-13px text-ink-3 mt-12px">
          Projected <RelativeTime value={data.projectedAt} />
        </p>
      ) : null}
    </div>
  );
}
