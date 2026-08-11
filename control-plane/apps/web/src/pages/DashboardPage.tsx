import useSWR from 'swr';
import { Card, StatTile, StatusBadge, RelativeTime, Button, Icon, PageLoading, PageHeader } from '../ui';
import { DataTable, type Column } from '../ui/DataTable';
import { GatewayLink } from '../components';

type Live = {
  gatewayId: string;
  status: string;
  runtimeVersion: string | null;
  agentCount: number | null;
  sessionCount: number | null;
  cronJobCount: number | null;
  pendingApprovals: number | null;
  error: string | null;
};

type Dashboard = {
  gateways: Live[];
  agentCount: number;
  pendingApprovals: number;
  pendingExecApprovals?: number;
  pendingResearchRequests?: number;
  generatedAt: string;
};

const columns: Column<Live>[] = [
  { key: 'gatewayId', header: 'Gateway', render: (g) => <GatewayLink id={g.gatewayId} /> },
  { key: 'status', header: 'Status', render: (g) => <StatusBadge status={g.status} /> },
  {
    key: 'version',
    header: 'Version',
    render: (g) => <span className="font-mono text-ink-2">{g.runtimeVersion ?? '—'}</span>,
  },
  { key: 'agents', header: 'Agents', render: (g) => g.agentCount ?? '—', align: 'right' },
  { key: 'sessions', header: 'Sessions', render: (g) => g.sessionCount ?? '—', align: 'right' },
  { key: 'cron', header: 'Cron', render: (g) => g.cronJobCount ?? '—', align: 'right' },
  {
    key: 'error',
    header: 'Error',
    render: (g) => (g.error ? <span className="text-bad">{g.error}</span> : <span className="text-ink-3">—</span>),
  },
];

export function DashboardPage() {
  const { data, error, mutate, isLoading } = useSWR<Dashboard>('/api/dashboard', { refreshInterval: 30_000 });

  if (isLoading && !data) return <PageLoading />;

  const onlineCount = data?.gateways.filter((g) => g.status === 'online').length ?? 0;

  return (
    <div>
      <PageHeader
        title="Dashboard"
        subtitle="Fleet health across the main, scout, and curator gateways."
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

      {data ? (
        <>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-14px mb-16px">
            <StatTile label="Gateways" value={data.gateways.length} hint={`${onlineCount} online`} icon={<Icon.Server size={16} />} />
            <StatTile label="Agents" value={data.agentCount} hint="Across all cells" icon={<Icon.Robot size={16} />} />
            <StatTile
              label="Pending approvals"
              value={data.pendingApprovals}
              hint={`Exec ${data.pendingExecApprovals ?? '—'} · Research ${data.pendingResearchRequests ?? '—'}`}
              icon={<Icon.Shield size={16} />}
            />
          </div>

          <Card title="Gateway status">
            <DataTable columns={columns} rows={data.gateways} rowKey={(g) => g.gatewayId} />
            <p className="text-13px text-ink-3 mt-12px m-0">
              Updated <RelativeTime value={data.generatedAt} />
            </p>
          </Card>
        </>
      ) : null}
    </div>
  );
}
