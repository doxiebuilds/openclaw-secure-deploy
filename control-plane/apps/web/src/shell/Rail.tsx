import classNames from 'classnames';
import { memo, type ComponentType } from 'react';
import { NavLink } from 'react-router-dom';
import { useApprovals } from '../approvals';
import { Icon, Logo } from '../ui';
import { useTheme } from '../theme/ThemeProvider';
import { useAuth } from '../auth';

type RailItem = {
  to: string;
  label: string;
  icon: ComponentType<{ size?: number }>;
  end?: boolean;
  /** Renders the pending-approvals count rather than a fixed badge. */
  approvalsBadge?: boolean;
};

/**
 * Module scope: this list never changes, and rebuilding it per render made
 * every entry a new element for React to reconcile on each fleet snapshot.
 */
const ITEMS: RailItem[] = [
  { to: '/', label: 'Dashboard', icon: Icon.Dashboard, end: true },
  { to: '/gateways', label: 'Gateways', icon: Icon.Server },
  { to: '/agents', label: 'Agents', icon: Icon.Robot },
  { to: '/approvals', label: 'Approvals', icon: Icon.Shield, approvalsBadge: true },
  { to: '/automations', label: 'Automations', icon: Icon.Play },
  { to: '/exchange', label: 'Exchange', icon: Icon.Folder },
  { to: '/config', label: 'Configuration', icon: Icon.Config },
  { to: '/security', label: 'Security', icon: Icon.Lock },
  { to: '/audit', label: 'Audit', icon: Icon.Audit },
];

/** Shared by every rail control, so hover feedback is identical across them. */
const RAIL_BUTTON =
  'relative ocp-center size-40px rd-11px rail-item text-ink-2 hover:text-ink';

/**
 * Only this subscribes to the approvals stream, so a change in the pending
 * count repaints one dot instead of re-rendering the whole rail.
 */
const ApprovalsBadge = memo(function ApprovalsBadge() {
  const pending = useApprovals().data?.counts.total ?? 0;
  if (!pending) return null;
  return (
    <span
      className="absolute -top-2px -right-2px min-w-16px h-16px px-4px rd-full bg-bad text-[var(--ocp-ink-on)] text-10px font-semibold ocp-center"
      aria-label={`${pending} pending`}
    >
      {pending > 99 ? '99+' : pending}
    </span>
  );
});

/** Homemade tip: absolutely positioned, never participates in flex layout. */
function RailTip({ label }: { label: string }) {
  return (
    <span className="rail-tip" role="tooltip">
      {label}
    </span>
  );
}

export const Rail = memo(function Rail() {
  const { resolved, toggle } = useTheme();
  const { user, logout } = useAuth();

  return (
    <nav
      className="flex flex-col items-center py-12px gap-4px bg-panel border-r border-edge shrink-0 rail-nav"
      style={{ width: 'var(--ocp-rail)' }}
      aria-label="Primary"
    >
      <Logo className="mb-8px" />

      {ITEMS.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          aria-label={item.label}
          className={({ isActive }) =>
            classNames(RAIL_BUTTON, isActive && 'rail-item-active text-accent')
          }
        >
          <span className="rail-icon" aria-hidden="true">
            <item.icon size={20} />
          </span>
          {item.approvalsBadge ? <ApprovalsBadge /> : null}
          <RailTip label={item.label} />
        </NavLink>
      ))}

      <div className="mt-auto flex flex-col items-center gap-4px">
        <button
          type="button"
          onClick={toggle}
          aria-label={resolved === 'dark' ? 'Switch to light' : 'Switch to dark'}
          className={RAIL_BUTTON}
        >
          <span className="rail-icon" aria-hidden="true">
            {resolved === 'dark' ? <Icon.Sun size={18} /> : <Icon.Moon size={18} />}
          </span>
          <RailTip label={resolved === 'dark' ? 'Switch to light' : 'Switch to dark'} />
        </button>
        <button type="button" onClick={() => void logout()} aria-label="Log out" className={RAIL_BUTTON}>
          <span className="rail-icon" aria-hidden="true">
            <Icon.User size={18} />
          </span>
          <RailTip label={`Log out (${user?.username ?? ''})`} />
        </button>
      </div>
    </nav>
  );
});
