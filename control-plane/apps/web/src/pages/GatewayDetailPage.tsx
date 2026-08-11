import useSWR from 'swr';
import { useParams } from 'react-router-dom';
import { Card, PageHeader, PageLoading, StatusBadge, Badge, Button, Icon, RelativeTime } from '../ui';
import { DataTable, type Column } from '../ui/DataTable';
import { AgentLink } from '../components';
import { Link } from 'react-router-dom';

type Agent = { id: string; isDefault: boolean; model: string | null; identityName: string | null };
type Session = { key: string; agentId: string | null; updatedAt: number | null; kind: string | null };

export function GatewayDetailPage() {
  const { id = '' } = useParams();
  const { data: detail, isLoading } = useSWR<{ gateway: Record<string, unknown>; live: Record<string, unknown> }>(
    `/api/gateways/${id}`
  );
  const { data: agentsRes } = useSWR<{ items: Agent[] }>(`/api/gateways/${id}/agents`);
  const { data: sessionsRes } = useSWR<{ items: Session[] }>(`/api/gateways/${id}/sessions`);

  if (isLoading && !detail) return <PageLoading />;

  const gateway = detail?.gateway;
  const live = detail?.live;
  const agents = agentsRes?.items ?? [];
  const sessions = (sessionsRes?.items ?? []).slice(0, 40);

  const agentColumns: Column<Agent>[] = [
    { key: 'id', header: 'ID', render: (a) => <AgentLink gatewayId={id} agentId={a.id} /> },
    { key: 'default', header: 'Default', render: (a) => (a.isDefault ? <Badge tone="primary">Default</Badge> : '—') },
    { key: 'model', header: 'Model', render: (a) => <span className="font-mono text-ink-2">{a.model ?? '—'}</span> },
  ];

  const sessionColumns: Column<Session>[] = [
    {
      key: 'key',
      header: 'Key',
      render: (s) => (
        <Link to={`/gateways/${id}/sessions/${encodeURIComponent(s.key)}`} className="text-accent hover:underline font-mono">
          {s.key.length > 48 ? `${s.key.slice(0, 48)}…` : s.key}
        </Link>
      ),
    },
    { key: 'agent', header: 'Agent', render: (s) => s.agentId ?? '—' },
    { key: 'updated', header: 'Updated', render: (s) => <RelativeTime value={s.updatedAt} /> },
  ];

  return (
    <div>
      <PageHeader
        title={<span className="capitalize">Gateway: {id}</span>}
        subtitle={typeof gateway?.role === 'string' ? gateway.role : undefined}
        actions={
          typeof gateway?.hostHttpBase === 'string' ? (
            <Button
              icon={<Icon.Connect size={14} />}
              onClick={() => window.open(`${gateway.hostHttpBase}/`, '_blank', 'noreferrer')}
            >
              Native control UI
            </Button>
          ) : null
        }
      />

      {live ? (
        <Card className="mb-14px">
          <div className="flex items-center gap-8px flex-wrap">
            <StatusBadge status={String(live.status)} />
            <Badge>{String(live.runtimeVersion ?? '—')}</Badge>
            <Badge>Agents {String(live.agentCount ?? '—')}</Badge>
            <Badge>Sessions {String(live.sessionCount ?? '—')}</Badge>
            <Badge>Cron {String(live.cronJobCount ?? '—')}</Badge>
          </div>
          {live.error ? <p className="text-13px text-bad mt-10px m-0">{String(live.error)}</p> : null}
        </Card>
      ) : null}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-14px">
        <Card title="Agents">
          <DataTable columns={agentColumns} rows={agents} rowKey={(a) => a.id} emptyTitle="No agents" />
        </Card>
        <Card title="Recent sessions">
          <DataTable columns={sessionColumns} rows={sessions} rowKey={(s) => s.key} emptyTitle="No sessions" />
        </Card>
      </div>
    </div>
  );
}
