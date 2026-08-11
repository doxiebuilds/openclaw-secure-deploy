import { useLocation } from 'react-router-dom';
import classNames from 'classnames';
import { Icon, StatusDot } from '../ui';
import type { Tone } from '../ui/Badge';
import type { ConnectionState } from '../realtime/useFleetStream';
import { useConnectionState } from '../realtime/RealtimeProvider';

const TITLES: Array<[RegExp, string]> = [
  [/^\/$/, 'Dashboard'],
  [/^\/gateways\/[^/]+\/agents\/[^/]+/, 'Agent'],
  [/^\/gateways\/[^/]+\/sessions\/.+/, 'Session'],
  [/^\/gateways\/[^/]+$/, 'Gateway'],
  [/^\/gateways/, 'Gateways'],
  [/^\/agents/, 'Agents'],
  [/^\/approvals/, 'Approvals'],
  [/^\/automations/, 'Automations'],
  [/^\/exchange/, 'Exchange'],
  [/^\/config/, 'Configuration'],
  [/^\/security/, 'Security'],
  [/^\/audit/, 'Audit'],
];

function titleFor(pathname: string): string {
  return TITLES.find(([re]) => re.test(pathname))?.[1] ?? 'OpenClaw Control Plane';
}

const CONNECTION_LABEL: Record<ConnectionState, string> = {
  connected: 'Live',
  connecting: 'Connecting…',
  offline: 'Offline',
};

const CONNECTION_TONE: Record<ConnectionState, Tone> = {
  connected: 'success',
  connecting: 'warning',
  offline: 'danger',
};

export function TopBar({
  onToggleSider,
  onToggleWorkspace,
  workspaceAvailable,
}: {
  onToggleSider: () => void;
  onToggleWorkspace: () => void;
  workspaceAvailable: boolean;
}) {
  const location = useLocation();
  const connectionState = useConnectionState();

  return (
    <header
      className="flex items-center gap-8px px-16px shrink-0 border-b border-edge"
      style={{
        height: 'var(--ocp-topbar)',
        background: 'color-mix(in srgb, var(--ocp-canvas) 92%, transparent)',
        backdropFilter: 'saturate(110%) blur(6px)',
      }}
    >
      <button
        type="button"
        onClick={onToggleSider}
        aria-label="Toggle sidebar"
        className="ocp-center size-30px rd-8px text-ink-2 hover:bg-hover hover:text-ink transition-colors duration-150"
      >
        <Icon.ExpandLeft size={16} />
      </button>

      <div className="text-14px font-semibold text-ink">{titleFor(location.pathname)}</div>

      <div className="flex-1" />

      <div
        className="flex items-center gap-6px px-10px py-4px rd-full border border-edge text-12px text-ink-2"
        title={`Realtime stream: ${connectionState}`}
      >
        <StatusDot tone={CONNECTION_TONE[connectionState]} />
        {CONNECTION_LABEL[connectionState]}
      </div>

      {workspaceAvailable ? (
        <button
          type="button"
          onClick={onToggleWorkspace}
          aria-label="Toggle workspace panel"
          className={classNames(
            'ocp-center size-30px rd-8px text-ink-2 hover:bg-hover hover:text-ink transition-colors duration-150'
          )}
        >
          <Icon.Layers size={16} />
        </button>
      ) : null}
    </header>
  );
}
