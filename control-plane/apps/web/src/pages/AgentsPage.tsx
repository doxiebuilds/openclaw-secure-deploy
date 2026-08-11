import useSWR from 'swr';
import { Card, PageHeader, PageLoading, Badge } from '../ui';
import { DataTable, type Column } from '../ui/DataTable';
import { AgentLink, GatewayLink } from '../components';

type Agent = {
  gatewayId: string;
  id: string;
  isDefault: boolean;
  model: string | null;
  identityName: string | null;
};

const columns: Column<Agent>[] = [
  { key: 'id', header: 'Agent', render: (a) => <AgentLink gatewayId={a.gatewayId} agentId={a.id} /> },
  { key: 'gateway', header: 'Gateway', render: (a) => <GatewayLink id={a.gatewayId} /> },
  { key: 'default', header: 'Default', render: (a) => (a.isDefault ? <Badge tone="primary">Default</Badge> : '—') },
  { key: 'identity', header: 'Identity', render: (a) => a.identityName ?? '—' },
  { key: 'model', header: 'Model', render: (a) => <span className="font-mono text-ink-2">{a.model ?? '—'}</span> },
];

export function AgentsPage() {
  const { data, isLoading } = useSWR<{ items: Agent[] }>('/api/agents');

  if (isLoading && !data) return <PageLoading />;

  return (
    <div>
      <PageHeader title="Agents" subtitle="All agents across registered OpenClaw gateways." />
      <Card padded={false}>
        <DataTable columns={columns} rows={data?.items ?? []} rowKey={(a) => `${a.gatewayId}:${a.id}`} />
      </Card>
    </div>
  );
}
