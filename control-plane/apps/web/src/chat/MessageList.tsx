import { MessageBubble, type ChatMessage } from './MessageBubble';
import { useAutoScroll } from './useAutoScroll';
import { EmptyState } from '../ui';
import { Icon } from '../ui/Icon';

export function MessageList({ messages }: { messages: ChatMessage[] }) {
  const { containerRef, sentinelRef, contentRef, following, scrollToBottom } = useAutoScroll();

  return (
    <div className="relative flex-1 min-h-0">
      <div ref={containerRef} className="chat-scroll h-full px-4px">
        <div ref={contentRef} style={{ containerType: 'inline-size' }}>
          <div className="mx-auto" style={{ width: 'calc(100% - clamp(0px, 4cqw, 80px))', maxWidth: 860 }}>
            {messages.length === 0 ? (
              <EmptyState title="No messages yet" description="Send a message below to start this session." />
            ) : (
              messages.map((m, i) => <MessageBubble key={i} message={m} />)
            )}
          </div>
          {/* Watched by useAutoScroll to decide whether the reader is at the end. */}
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
