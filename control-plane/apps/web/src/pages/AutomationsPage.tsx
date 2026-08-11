import { useState } from 'react';
import useSWR from 'swr';
import { api } from '../api';
import { Card, PageHeader, PageLoading, Badge, Button, Select, RelativeTime, Icon } from '../ui';
import { DataTable, type Column } from '../ui/DataTable';
import { JsonView } from '../ui/JsonView';
import { useConfirmDialog } from '../ui/ConfirmDialog';
import { toast } from '../ui/toast';
import { GatewayLink } from '../components';

type CronJob = {
  gatewayId: string;
  id: string;
  declarationKey: string | null;
  name: string | null;
  enabled: boolean | null;
  agentId: string | null;
  description: string | null;
  schedule: unknown;
  nextRunAtMs: number | null;
  lastStatus: string | null;
};

function formatSchedule(schedule: unknown): string {
  if (!schedule || typeof schedule !== 'object') return '—';
  const s = schedule as Record<string, unknown>;
  if (s.kind === 'cron' && typeof s.expr === 'string') return s.expr + (s.tz ? ` (${s.tz})` : '');
  if (s.kind === 'every' && s.everyMs) return `every ${s.everyMs}ms`;
  if (s.kind === 'at' && s.atMs) return `at ${new Date(Number(s.atMs)).toISOString()}`;
  return JSON.stringify(s);
}

export function AutomationsPage() {
  const [filter, setFilter] = useState('');
  const { data, mutate, isLoading } = useSWR<{ items: CronJob[] }>(
    `/api/cron/jobs${filter ? `?gatewayId=${encodeURIComponent(filter)}` : ''}`
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [runs, setRuns] = useState<{ gatewayId: string; jobId: string; runs: unknown } | null>(null);
  const { confirm, node: confirmNode } = useConfirmDialog();

  async function setEnabled(job: CronJob, enabled: boolean) {
    setBusy(job.id);
    try {
      const path = enabled ? 'enable' : 'disable';
      await api(`/api/cron/jobs/${job.gatewayId}/${job.id}/${path}`, { method: 'POST' });
      toast.success(`${enabled ? 'Enabled' : 'Disabled'} ${job.declarationKey || job.id}`);
      await mutate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function runNow(job: CronJob) {
    const ok = await confirm({
      title: 'Run job now?',
      description: `Run ${job.declarationKey || job.id} now on ${job.gatewayId}.`,
      confirmLabel: 'Run now',
    });
    if (!ok) return;
    setBusy(job.id);
    try {
      const res = await api<{ result: unknown }>(`/api/cron/jobs/${job.gatewayId}/${job.id}/run`, { method: 'POST' });
      toast.success(`Enqueued: ${JSON.stringify(res.result)}`);
      await mutate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function loadRuns(job: CronJob) {
    setBusy(job.id);
    try {
      const res = await api<{ runs: unknown }>(`/api/cron/jobs/${job.gatewayId}/${job.id}/runs?limit=10`);
      setRuns({ jobId: job.id, gatewayId: job.gatewayId, runs: res.runs });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  if (isLoading && !data) return <PageLoading />;
  const items = data?.items ?? [];

  const columns: Column<CronJob>[] = [
    { key: 'gateway', header: 'Gateway', render: (j) => <GatewayLink id={j.gatewayId} /> },
    {
      key: 'name',
      header: 'Name / key',
      render: (j) => (
        <div>
          <div>{j.name || '—'}</div>
          <div className="font-mono text-12px text-ink-3">{j.declarationKey || j.id}</div>
          {j.description ? <div className="text-12px text-ink-2">{j.description.slice(0, 80)}</div> : null}
        </div>
      ),
    },
    { key: 'agent', header: 'Agent', render: (j) => j.agentId ?? '—' },
    { key: 'schedule', header: 'Schedule', render: (j) => <span className="font-mono text-ink-2">{formatSchedule(j.schedule)}</span> },
    { key: 'enabled', header: 'Enabled', render: (j) => <Badge tone={j.enabled ? 'success' : 'muted'}>{j.enabled ? 'On' : 'Off'}</Badge> },
    {
      key: 'next',
      header: 'Next / last',
      render: (j) => (
        <div>
          <div>{j.nextRunAtMs ? <RelativeTime value={j.nextRunAtMs} /> : '—'}</div>
          <div className="text-12px text-ink-3">{j.lastStatus ?? ''}</div>
        </div>
      ),
    },
    {
      key: 'actions',
      header: 'Actions',
      render: (j) => (
        <div className="flex items-center gap-6px flex-wrap">
          <Button size="sm" disabled={busy === j.id || j.enabled === true} onClick={() => void setEnabled(j, true)}>
            Enable
          </Button>
          <Button size="sm" disabled={busy === j.id || j.enabled === false} onClick={() => void setEnabled(j, false)}>
            Disable
          </Button>
          <Button size="sm" variant="primary" disabled={busy === j.id} onClick={() => void runNow(j)}>
            Run
          </Button>
          <Button size="sm" variant="text" disabled={busy === j.id} onClick={() => void loadRuns(j)}>
            Runs
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Automations"
        subtitle="OpenClaw Gateway cron jobs — the gateway remains source of truth."
        actions={
          <>
            <Select value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: 160 }}>
              <option value="">All gateways</option>
              <option value="main">main</option>
              <option value="scout">scout</option>
              <option value="curator">curator</option>
            </Select>
            <Button icon={<Icon.Refresh size={14} />} onClick={() => void mutate()}>
              Refresh
            </Button>
          </>
        }
      />

      <Card padded={false}>
        <DataTable columns={columns} rows={items} rowKey={(j) => `${j.gatewayId}:${j.id}`} emptyTitle="No cron jobs found" />
      </Card>

      {runs ? (
        <Card title={`Run history · ${runs.gatewayId} / ${runs.jobId}`} className="mt-14px">
          <JsonView value={runs.runs} />
        </Card>
      ) : null}
      {confirmNode}
    </div>
  );
}
