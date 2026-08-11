import { useRef, useState, type KeyboardEvent } from 'react';
import { Icon } from '../ui';

export function Composer({
  onSend,
  disabled,
}: {
  onSend: (text: string) => Promise<void> | void;
  disabled?: boolean;
}) {
  const [value, setValue] = useState('');
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  async function submit() {
    const text = value.trim();
    if (!text || sending || disabled) return;
    setSending(true);
    try {
      await onSend(text);
      setValue('');
      textareaRef.current?.focus();
    } finally {
      setSending(false);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      void submit();
    }
  }

  return (
    <div className="sticky bottom-0 pt-8px pb-16px bg-canvas">
      <div className="rd-20px border border-edge bg-raised p-8px flex items-end gap-8px" style={{ boxShadow: 'var(--ocp-elev)' }}>
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Message to the agent… (⌘Enter to send)"
          rows={1}
          disabled={disabled}
          className="flex-1 resize-none bg-transparent border-none outline-none text-14px text-ink placeholder:text-ink-3 px-8px py-8px max-h-160px"
          onInput={(e) => {
            const el = e.currentTarget;
            el.style.height = 'auto';
            el.style.height = `${Math.min(160, el.scrollHeight)}px`;
          }}
        />
        <button
          type="button"
          onClick={() => void submit()}
          disabled={disabled || sending || !value.trim()}
          aria-label="Send message"
          className="shrink-0 ocp-center size-36px rd-full bg-[var(--ocp-accent)] text-[var(--ocp-ink-on)] disabled:opacity-40 disabled:cursor-not-allowed transition-opacity duration-150"
        >
          {sending ? (
            <span
              className="inline-block size-14px border-2 border-t-transparent border-current rd-full"
              style={{ animation: 'ocp-spin 0.7s linear infinite' }}
            />
          ) : (
            <Icon.Send size={16} fill="#fff" />
          )}
        </button>
      </div>
    </div>
  );
}
