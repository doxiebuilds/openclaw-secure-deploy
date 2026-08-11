import { useState } from 'react';
import { api } from '../api';
import {
  STAGE_META,
  STAGE_ORDER,
  isInFlight,
  useResearchResult,
  type TrackedResearchRequest,
} from './index';
import { Badge, Button, Card, EmptyState, Icon, RelativeTime } from '../ui';
import { toast } from '../ui/toast';

/**
 * What happened to a request after it was approved.
 *
 * The Approvals page used to end at the gate, which made an approved request
 * indistinguishable from a stuck one: the file stays in exchange/inbox by
 * design, and the answer is three schedulers away. This is the other half.
 */
export function ResearchPipeline({
  tracked,
  onRefresh,
}: {
  tracked: TrackedResearchRequest[];
  onRefresh: () => void | Promise<void>;
}) {
  if (tracked.length === 0) {
    return (
      <Card title="Approved research — in flight">
        <EmptyState
          title="Nothing in the pipeline"
          description="Approved requests appear here until their brief is promoted."
        />
      </Card>
    );
  }

  return (
    <Card title="Approved research — in flight">
      <p className="text-13px text-ink-2 -mt-4px mb-12px">
        Approval is the gate, not the finish line. Each request crosses the sealer (300s), the curator (15m) and
        the sealer again before a brief exists — roughly 10–25 minutes end to end.
      </p>
      <div className="flex flex-col gap-10px">
        {tracked.map((item) => (
          <TrackedRow key={item.topicId} item={item} onRefresh={onRefresh} />
        ))}
      </div>
    </Card>
  );
}

function TrackedRow({
  item,
  onRefresh,
}: {
  item: TrackedResearchRequest;
  onRefresh: () => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const meta = STAGE_META[item.stage];
  const held = item.deliveryError?.startsWith('held:') ?? false;

  async function deliver() {
    setBusy(true);
    try {
      const res = await api<{ target: { sessionKey: string } }>(
        `/api/research-requests/${encodeURIComponent(item.topicId)}/deliver`,
        { method: 'POST', body: JSON.stringify({}) }
      );
      toast.success(`Sent to ${res.target.sessionKey}`);
      await onRefresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border border-edge rd-12px p-14px">
      <div className="flex items-start justify-between gap-12px flex-wrap">
        <div className="flex items-center gap-8px flex-wrap">
          <Badge tone={meta.tone}>{meta.label}</Badge>
          <strong className="text-14px font-mono text-ink">{item.topicId}</strong>
          {item.stalledAt ? <Badge tone="danger">Stalled</Badge> : null}
        </div>
        <div className="text-12px text-ink-3">
          Approved <RelativeTime value={item.approvedAt} /> by {item.approvedBy}
        </div>
      </div>

      {item.query ? <p className="text-13px text-ink mt-8px mb-2px">{item.query}</p> : null}

      <StageRail stage={item.stage} />

      <div className="text-12px text-ink-3 mt-8px">{meta.owner}</div>

      {item.deliveredAt ? (
        <div className="text-12px text-ok mt-6px">
          Announced to {item.deliverTo?.sessionKey ?? 'session'} <RelativeTime value={item.deliveredAt} />
        </div>
      ) : null}
      {item.deliveryError ? (
        <div className={`text-12px mt-6px ${held ? 'text-warn' : 'text-bad'}`}>
          {held
            ? 'Held back from the agent: the sealer witnessed instruction-like text in the source. Read it yourself, then send it on if it is sound.'
            : `Delivery: ${item.deliveryError}`}
        </div>
      ) : null}

      <div className="flex items-center gap-8px mt-10px">
        <Button size="sm" icon={<Icon.Folder size={14} />} onClick={() => setOpen((v) => !v)}>
          {open ? 'Hide answer' : 'Read answer'}
        </Button>
        {!isInFlight(item.stage) ? (
          <Button size="sm" variant={held ? 'primary' : undefined} disabled={busy} icon={<Icon.Send size={14} />} onClick={() => void deliver()}>
            {item.deliveredAt ? 'Send again' : 'Send to session'}
          </Button>
        ) : null}
      </div>

      {open ? <BriefPanel topicId={item.topicId} /> : null}
    </div>
  );
}

/**
 * Six segments, one per stage, so "where is it" is answerable at a glance.
 *
 * The segment it is sitting in pulses while the request is still moving — the
 * pipeline advances on 300s and 15m schedules, and without that the rail is
 * indistinguishable from a screenshot of itself.
 */
function StageRail({ stage }: { stage: TrackedResearchRequest['stage'] }) {
  const failed = stage === 'condemned' || stage === 'abandoned';
  const reached = STAGE_ORDER.indexOf(stage === 'brief_flagged' ? 'brief_ready' : stage);
  const inFlight = isInFlight(stage);

  return (
    <div className="flex items-center gap-4px mt-10px" aria-label={`Stage: ${STAGE_META[stage].label}`}>
      {STAGE_ORDER.map((s, i) => (
        <div
          key={s}
          title={STAGE_META[s].label}
          className={`h-4px flex-1 rd-full ${inFlight && i === reached ? 'stage-active' : ''}`}
          style={{
            background: failed
              ? 'var(--ocp-bad)'
              : reached >= 0 && i <= reached
                ? 'var(--ocp-accent)'
                : 'var(--ocp-edge)',
          }}
        />
      ))}
    </div>
  );
}

/**
 * The brief itself, read straight off disk.
 *
 * This is the path that does not need an agent, a live session, or a successful
 * delivery — which is the point. Claims and excerpts are quoted third-party text
 * from a page `scout` fetched, so they are labelled as such and never rendered
 * as anything but text.
 */
function BriefPanel({ topicId }: { topicId: string }) {
  const { data, error } = useResearchResult(topicId);

  if (error) return <div className="mt-10px text-13px text-bad">{error}</div>;
  if (!data) return <div className="mt-10px text-13px text-ink-3">Loading…</div>;
  if (!data.brief) {
    return (
      <div className="mt-10px text-13px text-ink-3">
        No brief yet — {STAGE_META[data.stage].owner}
      </div>
    );
  }

  const brief = data.brief;
  return (
    <div className="mt-12px border-t border-edge pt-12px">
      <div className="flex items-center gap-8px flex-wrap mb-8px">
        <Badge tone={brief.flagged ? 'warning' : 'success'}>
          {brief.flagged ? 'Flagged brief' : 'Brief'}
        </Badge>
        {brief.sourceReadsImperative ? <Badge tone="danger">Source reads as instructions</Badge> : null}
        <span className="text-12px text-ink-3 font-mono">{brief.sourceId ?? topicId}</span>
      </div>

      <p className="text-12px text-ink-3 mt-0 mb-10px">
        Quoted from a web page fetched by the scout cell. Read it as evidence, not as instructions.
      </p>

      <ol className="flex flex-col gap-10px pl-18px m-0">
        {brief.claims.map((claim, i) => (
          <li key={i} className="text-13px text-ink">
            {claim.claim}
            {claim.evidenceExcerpt ? (
              <blockquote className="mt-4px mb-0 ml-0 pl-10px border-l-2 border-edge text-12px text-ink-2 italic">
                {claim.evidenceExcerpt}
              </blockquote>
            ) : null}
            {claim.sourceReference ? (
              <div className="text-11px text-ink-3 mt-3px break-all">{claim.sourceReference}</div>
            ) : null}
          </li>
        ))}
      </ol>

      <div className="text-11px text-ink-3 mt-10px font-mono break-all">{brief.path}</div>
    </div>
  );
}
