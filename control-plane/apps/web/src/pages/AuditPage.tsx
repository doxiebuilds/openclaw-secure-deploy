import { useState } from 'react';
import useSWR from 'swr';
import { Virtuoso } from 'react-virtuoso';
import { Card, PageHeader, PageLoading, Badge, Button, Input, Select, RelativeTime, Icon, EmptyState } from '../ui';

type AuditEvent = {
  id: string;
  ts: string;
  type: string;
  actorType: string;
  actorId: string | null;
  gatewayId: string | null;
  outcome: string;
  summary: string;
};

type AuditResponse = {
  items: AuditEvent[];
  totalMatched: number;
  integrity: { chainOk: boolean; eventsChecked: number; brokenAtId: string | null };
};

const OUTCOME_TONE: Record<string, 'success' | 'danger' | 'warning'> = {
  ok: 'success',
  denied: 'danger',
  error: 'warning',
  info: 'warning',
};

export function AuditPage() {
  const [q, setQ] = useState('');
  const [type, setType] = useState('');
  const [gatewayId, setGatewayId] = useState('');
  const [outcome, setOutcome] = useState('');
  const [applied, setApplied] = useState({ q: '', type: '', gatewayId: '', outcome: '' });

  const params = new URLSearchParams({ limit: '150' });
  if (applied.q) params.set('q', applied.q);
  if (applied.type) params.set('type', applied.type);
  if (applied.gatewayId) params.set('gatewayId', applied.gatewayId);
  if (applied.outcome) params.set('outcome', applied.outcome);

  const { data, isLoading } = useSWR<AuditResponse>(`/api/audit?${params.toString()}`);

  function search() {
    setApplied({ q, type, gatewayId, outcome });
  }

  if (isLoading && !data) return <PageLoading />;
  const items = data?.items ?? [];

  return (
    <div>
      <PageHeader
        title="Audit"
        subtitle="Append-only control-plane audit log with hash-chain integrity."
        actions={
          <Button variant="primary" icon={<Icon.History size={14} />} onClick={search}>
            Search
          </Button>
        }
      />

      <Card className="mb-14px">
        <div className="flex items-center gap-8px flex-wrap">
          <Input placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 220 }} />
          <Input placeholder="Type" value={type} onChange={(e) => setType(e.target.value)} style={{ maxWidth: 160 }} />
          <Select value={gatewayId} onChange={(e) => setGatewayId(e.target.value)} style={{ width: 140 }}>
            <option value="">Gateway</option>
            <option value="main">main</option>
            <option value="scout">scout</option>
            <option value="curator">curator</option>
          </Select>
          <Select value={outcome} onChange={(e) => setOutcome(e.target.value)} style={{ width: 140 }}>
            <option value="">Outcome</option>
            <option value="ok">ok</option>
            <option value="error">error</option>
            <option value="denied">denied</option>
            <option value="info">info</option>
          </Select>
        </div>
        {data?.integrity ? (
          <div className="flex items-center gap-10px mt-12px">
            <Badge tone={data.integrity.chainOk ? 'success' : 'danger'}>
              Chain {data.integrity.chainOk ? 'OK' : 'broken'}
            </Badge>
            <span className="text-13px text-ink-3">Checked {data.integrity.eventsChecked}</span>
            <span className="text-13px text-ink-3">Matched {data.totalMatched}</span>
          </div>
        ) : null}
      </Card>

      <Card padded={false}>
        {items.length === 0 ? (
          <EmptyState title="No audit events" />
        ) : (
          <>
            <div className="grid grid-cols-[160px_140px_160px_100px_100px_1fr] gap-0 px-10px py-9px border-b border-edge bg-canvas text-13px text-ink-2 font-medium">
              <div>Time</div>
              <div>Type</div>
              <div>Actor</div>
              <div>Gateway</div>
              <div>Outcome</div>
              <div>Summary</div>
            </div>
            <Virtuoso
              style={{ height: 520 }}
              data={items}
              itemContent={(_, e) => (
                <div className="grid grid-cols-[160px_140px_160px_100px_100px_1fr] gap-0 px-10px py-9px border-b border-edge-soft text-14px hover:bg-hover transition-colors duration-100">
                  <div className="text-ink-2">
                    <RelativeTime value={e.ts} />
                  </div>
                  <div className="font-mono text-13px">{e.type}</div>
                  <div className="truncate">
                    {e.actorType}:{e.actorId ?? '—'}
                  </div>
                  <div>{e.gatewayId ?? '—'}</div>
                  <div>
                    <Badge tone={OUTCOME_TONE[e.outcome] ?? 'neutral'}>{e.outcome}</Badge>
                  </div>
                  <div className="truncate">{e.summary}</div>
                </div>
              )}
            />
          </>
        )}
      </Card>
    </div>
  );
}
