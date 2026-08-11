import useSWR from 'swr';
import { useParams } from 'react-router-dom';
import { Card, PageHeader, PageLoading, Badge, RelativeTime } from '../ui';
import { DataTable, type Column } from '../ui/DataTable';
import { GatewayLink } from '../components';
import { Link } from 'react-router-dom';

type Agent = {
  gatewayId: string;
  id: string;
  isDefault: boolean;
  model: string | null;
  identityName: string | null;
  workspace: string | null;
};

type Session = { key: string; updatedAt: number | null; kind: string | null; title?: string | null };

type CronJob = { id: string; declarationKey: string | null; name: string | null; enabled: boolean | null };

export function AgentDetailPage() {
  const { id = '', agentId = '' } = useParams();
  const { data, isLoading } = useSWR<{ agent: Agent; sessions: Session[]; cronJobs: CronJob[] }>(
    `/api/gateways/${id}/agents/${agentId}`
  );

  if (isLoading && !data) return <PageLoading />;

  const agent = data?.agent;
  const sessions = data?.sessions ?? [];
  const cronJobs = data?.cronJobs ?? [];

  const sessionColumns: Column<Session>[] = [
    {
      key: 'key',
      header: 'Session',
      render: (s) => (
        <Link
          to={`/gateways/${id}/sessions/${encodeURIComponent(s.key)}`}
          title={s.key}
          className="text-accent hover:underline"
        >
          {s.title || (s.key.length > 56 ? `${s.key.slice(0, 56)}…` : s.key)}
        </Link>
      ),
    },
    { key: 'updated', header: 'Updated', render: (s) => <RelativeTime value={s.updatedAt} /> },
  ];

  const cronColumns: Column<CronJob>[] = [
    { key: 'name', header: 'Key / name', render: (j) => <span className="font-mono">{j.declarationKey || j.name || j.id}</span> },
    { key: 'enabled', header: 'Enabled', render: (j) => (j.enabled == null ? '—' : j.enabled ? 'Yes' : 'No') },
  ];

  return (
    <div>
      <PageHeader
        title={`Agent: ${agentId}`}
        subtitle={
          <>
            Gateway <GatewayLink id={id} />
          </>
        }
      />
      {agent ? (
        <Card className="mb-14px">
          <div className="flex items-center gap-8px flex-wrap">
            {agent.isDefault ? <Badge tone="primary">Default</Badge> : null}
            <Badge>{agent.model ?? 'no model field'}</Badge>
          </div>
          <p className="text-13px text-ink-2 mt-8px m-0">Identity: {agent.identityName ?? '—'}</p>
          <p className="text-13px text-ink-3 font-mono mt-4px m-0">Workspace: {agent.workspace ?? '—'}</p>
        </Card>
      ) : null}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-14px">
        <Card title="Sessions">
          <DataTable columns={sessionColumns} rows={sessions} rowKey={(s) => s.key} emptyTitle="No sessions for this agent" />
        </Card>
        <Card title="Cron jobs">
          <DataTable
            columns={cronColumns}
            rows={cronJobs}
            rowKey={(j, i) => j.id || j.declarationKey || j.name || `cron-${i}`}
            emptyTitle="No matching cron jobs"
          />
          <p className="text-13px text-ink-3 mt-12px m-0">
            Source of truth remains the OpenClaw Gateway cron store — this is a projection.
          </p>
        </Card>
      </div>
    </div>
  );
}
