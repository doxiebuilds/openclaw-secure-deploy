import { ToolCallCard, type TimelineEvent } from './ToolCallCard';
import { useAutoScroll } from './useAutoScroll';
import { EmptyState, Icon } from '../ui';

export function TimelineList({ events }: { events: TimelineEvent[] }) {
  const { containerRef, sentinelRef, contentRef, following, scrollToBottom } = useAutoScroll();

  return (
    <div className="relative flex-1 min-h-0">
      <div ref={containerRef} className="chat-scroll h-full px-4px">
        <div ref={contentRef} className="max-w-860px mx-auto py-8px">
          {events.length === 0 ? (
            <EmptyState
              title="No timeline events yet"
              description="Tool calls and step events will appear here."
            />
          ) : (
            events.map((event) => <ToolCallCard key={event.id} event={event} />)
          )}
          <div ref={sentinelRef} aria-hidden="true" className="h-1px" />
        </div>
      </div>
      {following ? null : (
        <button
          type="button"
          onClick={() => scrollToBottom('smooth')}
          className="absolute bottom-12px left-1/2 -translate-x-1/2 ocp-center gap-6px px-12px py-6px rd-full bg-raised border border-edge text-13px text-ink-2 hover:text-ink transition-colors duration-150"
          style={{ boxShadow: 'var(--ocp-menu-shadow)' }}
        >
          <Icon.Down size={13} />
          Jump to latest
        </button>
      )}
    </div>
  );
}
