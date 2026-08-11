import classNames from 'classnames';
import { useMemo, useState, type ReactNode } from 'react';
import { EmptyState } from './EmptyState';
import { SkeletonRows } from './Skeleton';
import { Icon } from './Icon';

export type Column<T> = {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  width?: string;
  sortValue?: (row: T) => string | number;
  align?: 'left' | 'right' | 'center';
};

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  loading,
  emptyTitle = 'No results',
  emptyDescription,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T, index: number) => string;
  loading?: boolean;
  emptyTitle?: string;
  emptyDescription?: ReactNode;
}) {
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col?.sortValue) return rows;
    return [...rows].sort((a, b) => {
      const av = col.sortValue!(a);
      const bv = col.sortValue!(b);
      if (av < bv) return -1 * sort.dir;
      if (av > bv) return 1 * sort.dir;
      return 0;
    });
  }, [rows, sort, columns]);

  if (loading) {
    return (
      <div className="p-16px">
        <SkeletonRows rows={4} />
      </div>
    );
  }

  if (rows.length === 0) {
    return <EmptyState title={emptyTitle} description={emptyDescription} />;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-14px">
        <thead>
          <tr>
            {columns.map((col) => (
              <th
                key={col.key}
                className={classNames(
                  'sticky top-0 z-1 bg-canvas text-ink-2 font-medium text-13px text-left px-10px py-9px border-b border-edge whitespace-nowrap',
                  col.align === 'right' && 'text-right',
                  col.align === 'center' && 'text-center',
                  col.sortValue && 'cursor-pointer select-none'
                )}
                style={{ width: col.width }}
                aria-sort={
                  col.sortValue && sort?.key === col.key ? (sort.dir === 1 ? 'ascending' : 'descending') : undefined
                }
                tabIndex={col.sortValue ? 0 : undefined}
                role={col.sortValue ? 'button' : undefined}
                onClick={() => {
                  if (!col.sortValue) return;
                  setSort((prev) =>
                    prev?.key === col.key ? { key: col.key, dir: prev.dir === 1 ? -1 : 1 } : { key: col.key, dir: 1 }
                  );
                }}
                onKeyDown={(e) => {
                  if (!col.sortValue) return;
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setSort((prev) =>
                      prev?.key === col.key ? { key: col.key, dir: prev.dir === 1 ? -1 : 1 } : { key: col.key, dir: 1 }
                    );
                  }
                }}
              >
                <span className="inline-flex items-center gap-4px">
                  {col.header}
                  {col.sortValue && sort?.key === col.key ? (
                    sort.dir === 1 ? (
                      <Icon.Up size={12} />
                    ) : (
                      <Icon.Down size={12} />
                    )
                  ) : null}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row, i) => (
            <tr
              key={rowKey(row, i)}
              className={classNames('hover:bg-hover transition-colors duration-100', i % 2 === 1 && 'bg-[color-mix(in_srgb,var(--ocp-canvas)_50%,transparent)]')}
            >
              {columns.map((col) => (
                <td
                  key={col.key}
                  className={classNames(
                    'px-10px py-10px border-b border-edge-soft align-top',
                    col.align === 'right' && 'text-right',
                    col.align === 'center' && 'text-center'
                  )}
                >
                  {col.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
