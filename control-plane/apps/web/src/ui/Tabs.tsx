import classNames from 'classnames';

export type TabItem = { key: string; label: string; badge?: number };

export function Tabs({
  items,
  active,
  onChange,
}: {
  items: TabItem[];
  active: string;
  onChange: (key: string) => void;
}) {
  return (
    <div className="flex items-center gap-4px border-b border-edge" role="tablist">
      {items.map((item) => {
        const isActive = item.key === active;
        return (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(item.key)}
            className={classNames(
              'relative px-14px py-10px text-14px font-medium cursor-pointer transition-colors duration-150',
              isActive ? 'text-accent' : 'text-ink-2 hover:text-ink'
            )}
          >
            {item.label}
            {item.badge ? (
              <span className="ml-6px inline-flex items-center justify-center min-w-16px h-16px px-4px rd-full bg-[var(--ocp-bad-soft)] text-bad text-11px">
                {item.badge}
              </span>
            ) : null}
            {isActive ? (
              <span className="absolute left-0 right-0 -bottom-1px h-2px bg-accent rd-full" />
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
