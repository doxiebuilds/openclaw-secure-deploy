import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useApprovals } from '../approvals';
import type { ExecApproval, ResearchApproval } from '../approvals';
import { Card, PageHeader, PageLoading, StatTile, Badge, Button, Icon, EmptyState, RelativeTime } from '../ui';
import { CodeBlock } from '../ui/CodeBlock';
import { toast } from '../ui/toast';
import { GatewayLink } from '../components';
import { isInFlight, useResearchRequests } from '../research';
import { ResearchPipeline } from '../research/ResearchPipeline';

export function ApprovalsPage() {
  const { data, error, refresh: load } = useApprovals();
  const { data: researchData, refresh: loadResearch } = useResearchRequests();
  const [busyId, setBusyId] = useState<string | null>(null);

  const tracked = researchData?.tracked ?? [];
  const inFlight = tracked.filter((t) => isInFlight(t.stage));

  async function resolveExec(item: ExecApproval, decision: 'allow-once' | 'allow-always' | 'deny') {
    setBusyId(item.id);
    try {
      await api(`/api/approvals/exec/${item.gatewayId}/${encodeURIComponent(item.id)}/resolve`, {
        method: 'POST',
        body: JSON.stringify({ decision }),
      });
      toast.success(`Exec approval → ${decision}`);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  async function resolveResearch(item: ResearchApproval, decision: 'approve' | 'reject') {
    setBusyId(item.id);
    try {
      await api(`/api/approvals/research/${encodeURIComponent(item.id)}/resolve`, {
        method: 'POST',
        body: JSON.stringify({ decision }),
      });
      toast.success(
        decision === 'approve'
          ? 'Approved — tracking it through to the brief'
          : 'Research request → reject'
      );
      await Promise.all([load(), loadResearch()]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  if (!data && !error) return <PageLoading />;

  const items = data?.items ?? [];
  const execItems = items.filter((i): i is ExecApproval => i.kind === 'exec');
  const researchItems = items.filter((i): i is ResearchApproval => i.kind === 'research_request');

  return (
    <div>
      <PageHeader
        title="Approvals"
        subtitle="Human-in-the-loop: exec approvals and cross-cell research requests."
        actions={
          <Button
            icon={<Icon.Refresh size={14} />}
            onClick={() => void Promise.all([load(), loadResearch()])}
          >
            Refresh
          </Button>
        }
      />
      {error ? (
        <div className="mb-16px px-12px py-10px rd-10px text-13px text-bad bg-[var(--ocp-bad-soft)] border border-[var(--ocp-bad-edge)]">
          {error}
        </div>
      ) : null}

      <div className="grid grid-cols-1 md:grid-cols-4 gap-14px mb-16px">
        <StatTile label="Total pending" value={data?.counts.total ?? 0} icon={<Icon.Shield size={16} />} />
        <StatTile label="Exec approvals" value={data?.counts.exec ?? 0} icon={<Icon.Terminal size={16} />} />
        <StatTile label="Research requests" value={data?.counts.research_request ?? 0} icon={<Icon.Connect size={16} />} />
        <StatTile label="Research in flight" value={inFlight.length} icon={<Icon.Layers size={16} />} />
      </div>

      <Card title="Exec approvals" className="mb-14px">
        <p className="text-13px text-ink-2 -mt-4px mb-12px">
          Decisions map to <span className="font-mono">exec.approval.resolve</span>. Enforcement stays in OpenClaw / build-guard.
        </p>
        {execItems.length === 0 ? (
          <EmptyState title="No pending exec approvals" description="Queues are quiet right now." />
        ) : (
          <div className="flex flex-col gap-10px">
            {execItems.map((item) => (
              <div key={`${item.gatewayId}:${item.id}`} className="border border-edge rd-12px p-14px">
                <div className="flex items-start justify-between gap-12px flex-wrap">
                  <div className="flex items-center gap-8px flex-wrap">
                    <Badge tone="warning">Pending</Badge>
                    <strong className="text-14px text-ink">{item.title || item.toolName || 'Exec approval'}</strong>
                    {item.riskHint ? <Badge>{item.riskHint}</Badge> : null}
                  </div>
                  <GatewayLink id={item.gatewayId} />
                </div>
                <div className="text-12px text-ink-3 font-mono mt-6px">id={item.id}</div>
                {item.agentId ? <div className="text-13px text-ink-2 mt-2px">Agent: {item.agentId}</div> : null}
                {item.sessionKey ? (
                  <div className="text-13px text-ink-2 mt-2px">
                    Session:{' '}
                    <Link
                      to={`/gateways/${item.gatewayId}/sessions/${encodeURIComponent(item.sessionKey)}`}
                      className="text-accent hover:underline"
                    >
                      {item.sessionKey}
                    </Link>
                  </div>
                ) : null}
                {item.description ? <p className="text-13px text-ink mt-8px mb-0">{item.description}</p> : null}
                {item.command ? <CodeBlock code={item.command} language="bash" /> : null}
                <div className="flex items-center gap-8px mt-10px">
                  <Button variant="primary" size="sm" disabled={busyId === item.id} onClick={() => void resolveExec(item, 'allow-once')}>
                    Allow once
                  </Button>
                  <Button size="sm" disabled={busyId === item.id} onClick={() => void resolveExec(item, 'allow-always')}>
                    Allow always
                  </Button>
                  <Button variant="danger" size="sm" disabled={busyId === item.id} onClick={() => void resolveExec(item, 'deny')}>
                    Deny
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card title="Research requests (main → scout)">
        <p className="text-13px text-ink-2 -mt-4px mb-12px">
          Host-gated via <span className="font-mono">research-request-mover.sh</span>. Approve copies into scout's inbox; reject
          discards. Agents cannot run this script.
        </p>
        {researchItems.length === 0 ? (
          <EmptyState title="No pending research requests" />
        ) : (
          <div className="flex flex-col gap-10px">
            {researchItems.map((item) => (
              <div key={item.id} className="border border-edge rd-12px p-14px">
                <div className="flex items-center justify-between gap-12px flex-wrap">
                  <div className="flex items-center gap-8px">
                    <Badge tone={item.valid ? 'warning' : 'muted'}>{item.valid ? 'Pending' : 'Invalid'}</Badge>
                    <strong className="text-14px font-mono text-ink">{item.id}</strong>
                  </div>
                  <Badge>research_request</Badge>
                </div>
                <p className="text-13px text-ink mt-8px mb-2px">
                  <strong>Query:</strong> {item.query ?? '—'}
                </p>
                <div className="text-13px text-ink-3">topic_id: {item.topicId ?? '—'}</div>
                {!item.valid ? (
                  <div className="mt-8px text-13px text-bad">Invalid: {item.validationError ?? 'schema'}</div>
                ) : null}
                <div className="flex items-center gap-8px mt-10px">
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={busyId === item.id || !item.valid}
                    onClick={() => void resolveResearch(item, 'approve')}
                  >
                    Approve
                  </Button>
                  <Button variant="danger" size="sm" disabled={busyId === item.id} onClick={() => void resolveResearch(item, 'reject')}>
                    Reject
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <div className="mt-14px">
        <ResearchPipeline tracked={tracked} onRefresh={loadResearch} />
      </div>

      {data?.projectedAt ? (
        <p className="text-13px text-ink-3 mt-12px">
          Projected <RelativeTime value={data.projectedAt} />
        </p>
      ) : null}
    </div>
  );
}
