import { FleetTree } from './FleetTree';

export function Sider({ width, onDragHandlePointerDown }: { width: number; onDragHandlePointerDown: (e: React.PointerEvent) => void }) {
  return (
    <aside
      className="relative shrink-0 bg-panel border-r border-edge overflow-hidden flex flex-col ocp-sider-anim"
      style={{ width }}
      aria-label="Fleet navigation"
    >
      <div className="px-16px pt-16px pb-8px shrink-0" style={{ height: 'var(--ocp-topbar)' }}>
        <div className="flex items-center h-full text-13px font-semibold text-ink-2 uppercase tracking-wide">
          Fleet
        </div>
      </div>
      <div className="flex-1 overflow-y-auto pb-16px">
        <FleetTree />
      </div>
      <div
        className="absolute top-0 right-0 h-full w-8px z-20 cursor-col-resize group"
        onPointerDown={onDragHandlePointerDown}
        aria-hidden="true"
      >
        <div className="absolute top-0 right-0 h-full w-1px bg-transparent group-hover:bg-[var(--ocp-accent-edge)] transition-colors duration-150" />
      </div>
    </aside>
  );
}
