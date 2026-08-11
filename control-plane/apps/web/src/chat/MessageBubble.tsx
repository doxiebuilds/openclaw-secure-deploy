import { memo, useState } from 'react';
import classNames from 'classnames';
import { Markdown } from './Markdown';
import { blocksToPlainText, parseContent, type ContentBlock } from './messageContent';
import { Icon } from '../ui';
import { toast } from '../ui/toast';

export type ChatMessage = {
  role?: string;
  content?: unknown;
  text?: string;
  type?: string;
};

const USER_ROLES = new Set(['user', 'human']);

/**
 * Compared by value, not identity.
 *
 * Every stream frame is a fresh JSON.parse, so identity comparison would always
 * miss and every message would re-parse its markdown and re-highlight its code
 * whenever a single message elsewhere in the transcript changed. Serialising a
 * message object is orders of magnitude cheaper than that.
 */
export const MessageBubble = memo(
  MessageBubbleInner,
  (prev, next) => JSON.stringify(prev.message) === JSON.stringify(next.message)
);

function MessageBubbleInner({ message }: { message: ChatMessage }) {
  const [hover, setHover] = useState(false);
  const role = message.role || message.type || 'assistant';
  const isUser = USER_ROLES.has(role.toLowerCase());
  const blocks = parseContent(message.content ?? message.text);

  if (blocks.length === 0) return null;

  // A user turn is prose by construction; rendering it as one bubble keeps the
  // conversation readable and avoids wrapping a single line in block chrome.
  if (isUser) {
    const text = blocksToPlainText(blocks);
    if (!text.trim()) return null;
    return (
      <Row role={role} isUser hover={hover} setHover={setHover} copyText={text}>
        <div className="bg-bubble-user rd-16px rd-tr-4px px-14px py-10px text-14px text-ink whitespace-pre-wrap break-words">
          {text}
        </div>
      </Row>
    );
  }

  return (
    <Row role={role} isUser={false} hover={hover} setHover={setHover} copyText={blocksToPlainText(blocks)}>
      <div className="w-full flex flex-col gap-8px">
        {blocks.map((block, i) => (
          <Block key={i} block={block} />
        ))}
      </div>
    </Row>
  );
}

function Row({
  role,
  isUser,
  hover,
  setHover,
  copyText,
  children,
}: {
  role: string;
  isUser: boolean;
  hover: boolean;
  setHover: (v: boolean) => void;
  copyText: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={classNames('flex w-full mb-16px', isUser ? 'justify-end' : 'justify-start')}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <div className={classNames('flex flex-col', isUser ? 'items-end max-w-[75%]' : 'items-start w-full')}>
        {children}
        <div
          className={classNames(
            'flex items-center gap-8px mt-4px text-11px text-ink-3 transition-opacity duration-150',
            hover ? 'opacity-100' : 'opacity-0'
          )}
        >
          <span className="uppercase tracking-wide">{role}</span>
          <button
            type="button"
            className="hover:text-ink transition-colors duration-150"
            onClick={() => {
              void navigator.clipboard.writeText(copyText);
              toast.success('Copied to clipboard');
            }}
            aria-label="Copy message"
          >
            <Icon.Copy size={12} />
          </button>
        </div>
      </div>
    </div>
  );
}

function Block({ block }: { block: ContentBlock }) {
  switch (block.kind) {
    case 'text':
      return <Markdown text={block.text} />;

    // Collapsed by default: reasoning is useful when you go looking for it and
    // noise when you are reading the conversation.
    case 'thinking':
      return (
        <Disclosure
          icon={<Icon.Robot size={12} />}
          label="Reasoning"
          preview={firstLine(block.text)}
          tone="muted"
        >
          <div className="text-12px text-ink-2 whitespace-pre-wrap break-words">{block.text}</div>
        </Disclosure>
      );

    case 'toolCall':
      return (
        <Disclosure
          icon={<Icon.Terminal size={12} />}
          label={block.name}
          preview={block.args ? compact(block.args) : null}
          tone="tool"
          openable={Boolean(block.args)}
        >
          {block.args ? (
            <pre className="m-0 text-11px text-ink-2 font-mono whitespace-pre-wrap break-all">
              {block.args}
            </pre>
          ) : null}
        </Disclosure>
      );

    case 'toolResult':
      return (
        <Disclosure
          icon={block.ok ? <Icon.Check size={12} /> : <Icon.Attention size={12} />}
          label={`Result${block.tool ? ` · ${block.tool}` : ''}`}
          preview={firstLine(block.text)}
          tone={block.ok ? 'muted' : 'danger'}
          defaultOpen={!block.ok}
        >
          <div className="text-12px text-ink-2 whitespace-pre-wrap break-words font-mono">
            {block.text}
          </div>
        </Disclosure>
      );

    // The shape we could not identify. Still shown — hiding it would lose data —
    // but labelled, so raw JSON in the transcript reads as "unrecognised block"
    // rather than as something the agent said.
    case 'unknown':
      return (
        <Disclosure
          icon={<Icon.Attention size={12} />}
          label={block.type ? `Unrecognised block · ${block.type}` : 'Unrecognised block'}
          preview={compact(block.json)}
          tone="muted"
        >
          <pre className="m-0 text-11px text-ink-3 font-mono whitespace-pre-wrap break-all">
            {block.json}
          </pre>
        </Disclosure>
      );
  }
}

function Disclosure({
  icon,
  label,
  preview,
  tone,
  children,
  defaultOpen = false,
  openable = true,
}: {
  icon: React.ReactNode;
  label: string;
  preview: string | null;
  tone: 'muted' | 'tool' | 'danger';
  children: React.ReactNode;
  defaultOpen?: boolean;
  openable?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div
      className={classNames(
        'w-full border rd-10px px-10px py-6px',
        tone === 'danger'
          ? 'border-[var(--ocp-bad-edge)] bg-[var(--ocp-bad-soft)]'
          : tone === 'tool'
            ? 'border-[var(--ocp-warn-edge)] bg-[var(--ocp-warn-soft)]'
            : 'border-edge bg-canvas'
      )}
    >
      <button
        type="button"
        disabled={!openable}
        onClick={() => setOpen((v) => !v)}
        className={classNames(
          'w-full flex items-center gap-6px text-left bg-transparent border-0 p-0',
          openable && 'cursor-pointer'
        )}
        aria-expanded={open}
      >
        <span className={tone === 'danger' ? 'text-bad' : 'text-ink-3'}>{icon}</span>
        <span
          className={classNames(
            'text-11px uppercase tracking-wide font-medium shrink-0',
            tone === 'danger' ? 'text-bad' : 'text-ink-3'
          )}
        >
          {label}
        </span>
        {!open && preview ? (
          <span className="text-12px text-ink-3 truncate min-w-0 font-mono">{preview}</span>
        ) : null}
        {openable ? (
          <span className="ml-auto shrink-0 text-ink-3">
            {open ? <Icon.Up size={12} /> : <Icon.Down size={12} />}
          </span>
        ) : null}
      </button>
      {open ? <div className="mt-6px">{children}</div> : null}
    </div>
  );
}

function firstLine(text: string): string | null {
  const line = text.trim().split('\n')[0];
  return line ? line.slice(0, 160) : null;
}

function compact(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 160);
}
