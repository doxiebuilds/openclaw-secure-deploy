import { useParams } from 'react-router-dom';
import { useState, type ReactNode } from 'react';
import { Rail } from './Rail';
import { Sider } from './Sider';
import { TopBar } from './TopBar';
import { WorkspacePanel } from './WorkspacePanel';
import { useSiderCollapse } from './useSiderCollapse';
import { useResizablePanel } from './useResizablePanel';
import { useShortcuts } from './useShortcuts';
import { useIsMobile } from './useIsMobile';
import { useTheme } from '../theme/ThemeProvider';
import { Icon } from '../ui';

export function ShellLayout({ children }: { children: ReactNode }) {
  const { id: gatewayId, sessionKey } = useParams();
  const isMobile = useIsMobile();
  const sider = useSiderCollapse();
  const workspace = useResizablePanel({
    storageKey: 'ocp:workspace-width',
    defaultWidth: 260,
    minWidth: 220,
    maxWidth: 500,
  });
  const { toggle: toggleTheme } = useTheme();
  const [workspaceHidden, setWorkspaceHidden] = useState(false);

  const workspaceAvailable = Boolean(gatewayId);
  const showWorkspace = workspaceAvailable && !isMobile && !workspaceHidden;

  useShortcuts({
    onToggleSider: sider.toggle,
    onToggleWorkspace: () => setWorkspaceHidden((v) => !v),
    onToggleTheme: toggleTheme,
  });

  return (
    <div className="app-shell">
      <Rail />

      {isMobile && !sider.collapsed ? (
        <div
          className="fixed inset-0 z-90"
          style={{ background: 'rgba(0,0,0,0.3)' }}
          onClick={sider.toggle}
          aria-hidden="true"
        />
      ) : null}

      {!sider.collapsed || !isMobile ? (
        <div
          style={
            isMobile
              ? {
                  position: 'fixed',
                  left: 'var(--ocp-rail)',
                  top: 0,
                  bottom: 0,
                  zIndex: 100,
                  transform: sider.collapsed ? 'translateX(-100%)' : 'translateX(0)',
                }
              : undefined
          }
        >
          <Sider width={sider.collapsed ? 0 : sider.width} onDragHandlePointerDown={sider.onPointerDown} />
        </div>
      ) : null}

      <div className="app-main-column">
        <TopBar
          onToggleSider={sider.toggle}
          onToggleWorkspace={() => setWorkspaceHidden((v) => !v)}
          workspaceAvailable={workspaceAvailable && !isMobile}
        />
        <div className="app-content-row">
          <div className={sessionKey ? 'app-content-flush' : 'app-content-scroll'}>{children}</div>
          {showWorkspace ? (
            <WorkspacePanel width={workspace.width} onDragHandlePointerDown={workspace.onPointerDown} />
          ) : null}
          {workspaceAvailable && !isMobile && workspaceHidden ? (
            <button
              type="button"
              onClick={() => setWorkspaceHidden(false)}
              aria-label="Expand workspace panel"
              className="fixed z-101 flex items-center justify-center"
              style={{
                top: '50%',
                right: 0,
                transform: 'translateY(-50%)',
                width: 20,
                height: 64,
                borderTopLeftRadius: 10,
                borderBottomLeftRadius: 10,
                background: 'var(--ocp-panel)',
                border: '1px solid var(--ocp-edge)',
                borderRight: 'none',
                boxShadow: 'var(--ocp-elev)',
              }}
            >
              <span style={{ transform: 'rotate(180deg)', display: 'flex' }}>
                <Icon.ExpandLeft size={16} />
              </span>
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
