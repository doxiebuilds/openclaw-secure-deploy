import useSWR from 'swr';
import { Card, PageHeader, PageLoading, StatusBadge, Badge, Icon } from '../ui';
import { GatewayLink } from '../components';

type GatewayRow = {
  id: string;
  cell: number;
  role: string;
  hostHttpBase: string;
  expectedAgents: string[];
  live: {
    status: string;
    runtimeVersion: string | null;
    agentCount: number | null;
    sessionCount: number | null;
    cronJobCount: number | null;
    error: string | null;
  } | null;
};

export function GatewaysPage() {
  const { data, error, isLoading } = useSWR<{ items: GatewayRow[] }>('/api/gateways');

  if (isLoading && !data) return <PageLoading />;
  const items = data?.items ?? [];

  return (
    <div>
      <PageHeader title="Gateways" subtitle="Registered OpenClaw gateways in this fleet." />
      {error ? (
        <div className="mb-16px px-12px py-10px rd-10px text-13px text-bad bg-[var(--ocp-bad-soft)] border border-[var(--ocp-bad-edge)]">
          {error instanceof Error ? error.message : String(error)}
        </div>
      ) : null}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-14px">
        {items.map((g) => (
          <Card key={g.id}>
            <div className="flex items-center justify-between mb-6px">
              <h3 className="m-0 text-15px font-semibold capitalize">
                <GatewayLink id={g.id} />
              </h3>
              <StatusBadge status={g.live?.status ?? 'unknown'} />
            </div>
            <p className="text-13px text-ink-3 m-0">Cell {g.cell}</p>
            <p className="text-14px text-ink my-6px">{g.role}</p>
            <div className="font-mono text-12px text-ink-3 truncate">{g.hostHttpBase}</div>
            <div className="flex items-center gap-8px flex-wrap mt-10px">
              <Badge>Agents {g.live?.agentCount ?? '—'}</Badge>
              <Badge>Sessions {g.live?.sessionCount ?? '—'}</Badge>
              <Badge>Cron {g.live?.cronJobCount ?? '—'}</Badge>
            </div>
            {g.live?.error ? <p className="text-13px text-bad mt-10px m-0">{g.live.error}</p> : null}
            <p className="text-13px text-ink-2 mt-10px m-0">Expected: {g.expectedAgents.join(', ')}</p>
            <a
              href={`${g.hostHttpBase}/`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-4px text-13px text-accent hover:underline mt-6px"
            >
              <Icon.Connect size={13} />
              Open native control UI
            </a>
          </Card>
        ))}
      </div>
    </div>
  );
}
