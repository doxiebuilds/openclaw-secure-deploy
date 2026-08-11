import classNames from 'classnames';
import type { CSSProperties } from 'react';

const shimmerStyle: CSSProperties = {
  backgroundImage: 'linear-gradient(90deg, var(--ocp-panel) 25%, var(--ocp-recess) 37%, var(--ocp-panel) 63%)',
  backgroundSize: '400% 100%',
  animation: 'shimmer-scan 1.5s ease-in-out infinite',
};

export function Skeleton({ className, style }: { className?: string; style?: CSSProperties }) {
  return <div className={classNames('rd-8px', className)} style={{ ...shimmerStyle, ...style }} />;
}

export function SkeletonLine({ width = '100%' }: { width?: string | number }) {
  return <Skeleton className="h-14px" style={{ width }} />;
}

export function SkeletonRows({ rows = 3 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-10px">
      {Array.from({ length: rows }).map((_, i) => (
        <SkeletonLine key={i} width={i === rows - 1 ? '60%' : '100%'} />
      ))}
    </div>
  );
}

export function SkeletonCard() {
  return (
    <div className="bg-raised border border-edge rd-14px p-16px flex flex-col gap-10px">
      <SkeletonLine width="40%" />
      <Skeleton className="h-28px" style={{ width: '60%' }} />
      <SkeletonLine width="80%" />
    </div>
  );
}
