import useSWR from 'swr';
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { Tabs, EmptyState, Badge, Icon } from '../ui';
import { SkeletonRows } from '../ui/Skeleton';
import { RelativeTime } from '../ui/RelativeTime';
import { useApprovals } from '../approvals';

type CronJob = {
  gatewayId: string;
  id: string;
  declarationKey: string | null;
  name: string | null;
  enabled: boolean | null;
  nextRunAtMs?: number | null;
};

type ExchangeDir = {
  name: string;
  exists: boolean;
  fileCount: number;
  newestMtimeMs: number | null;
  sampleNames: string[];
};

function ApprovalsTab({ gatewayId }: { gatewayId: string }) {
  const { data } = useApprovals();
  const items = (data?.items ?? []).filter((i) =>
    i.kind === 'exec' ? i.gatewayId === gatewayId : gatewayId === 'main'
  );
  if (items.length === 0) return <EmptyState title="No pending approvals" />;
  return (
    <div className="flex flex-col gap-8px">
      {items.map((item) => (
        <div key={item.id} className="border border-edge rd-10px p-10px">
          <div className="text-13px font-medium text-ink">
            {item.kind === 'exec' ? item.title || item.toolName || 'Exec approval' : `Research: ${item.query ?? item.id}`}
          </div>
          <div className="text-12px text-ink-3 mt-2px font-mono">{item.id}</div>
        </div>
      ))}
    </div>
  );
}

function CronTab({ gatewayId }: { gatewayId: string }) {
  const { data, isLoading } = useSWR<{ items: CronJob[] }>(`/api/cron/jobs?gatewayId=${gatewayId}`);
  if (isLoading) return <SkeletonRows rows={3} />;
  const items = data?.items ?? [];
  if (items.length === 0) return <EmptyState title="No cron jobs" />;
  return (
    <div className="flex flex-col gap-8px">
      {items.map((job) => (
        <div key={job.id} className="border border-edge rd-10px p-10px">
          <div className="flex items-center justify-between gap-8px">
            <span className="text-13px font-medium text-ink truncate">{job.name || job.declarationKey || job.id}</span>
            <Badge tone={job.enabled ? 'success' : 'muted'}>{job.enabled ? 'On' : 'Off'}</Badge>
          </div>
          {job.nextRunAtMs ? (
            <div className="text-12px text-ink-3 mt-2px">
              Next <RelativeTime value={job.nextRunAtMs} />
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function ExchangeTab() {
  const { data, isLoading } = useSWR<{ dirs: ExchangeDir[] }>('/api/exchange');
  if (isLoading) return <SkeletonRows rows={3} />;
  const dirs = data?.dirs ?? [];
  if (dirs.length === 0) return <EmptyState title="No exchange directories" />;
  return (
    <div className="flex flex-col gap-8px">
      {dirs.map((d) => (
        <div key={d.name} className="border border-edge rd-10px p-10px">
          <div className="flex items-center justify-between">
            <span className="text-13px font-medium text-ink flex items-center gap-6px">
              <Icon.Folder size={13} className="text-ink-3" />
              {d.name}
            </span>
            <Badge tone={d.exists ? 'success' : 'muted'}>{d.exists ? `${d.fileCount} files` : 'missing'}</Badge>
          </div>
          {d.sampleNames.slice(0, 4).map((n) => (
            <div key={n} className="text-12px text-ink-3 font-mono mt-4px truncate">
              {n}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export function WorkspacePanel({ width, onDragHandlePointerDown }: { width: number; onDragHandlePointerDown: (e: React.PointerEvent) => void }) {
  const { id: gatewayId } = useParams();
  const [tab, setTab] = useState('approvals');

  if (!gatewayId) return null;

  return (
    <aside
      className="relative shrink-0 bg-raised border-l border-edge flex flex-col overflow-hidden"
      style={{ width }}
    >
      <div
        className="absolute top-0 left-0 h-full w-8px z-20 cursor-col-resize group"
        onPointerDown={onDragHandlePointerDown}
        aria-hidden="true"
      >
        <div className="absolute top-0 left-0 h-full w-1px bg-transparent group-hover:bg-[var(--ocp-accent-edge)] transition-colors duration-150" />
      </div>
      <div className="px-14px pt-14px shrink-0">
        <Tabs
          active={tab}
          onChange={setTab}
          items={[
            { key: 'approvals', label: 'Approvals' },
            { key: 'cron', label: 'Cron' },
            { key: 'exchange', label: 'Exchange' },
          ]}
        />
      </div>
      <div className="flex-1 overflow-y-auto p-14px">
        {tab === 'approvals' ? <ApprovalsTab gatewayId={gatewayId} /> : null}
        {tab === 'cron' ? <CronTab gatewayId={gatewayId} /> : null}
        {tab === 'exchange' ? <ExchangeTab /> : null}
      </div>
    </aside>
  );
}
