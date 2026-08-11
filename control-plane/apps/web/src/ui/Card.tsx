import classNames from 'classnames';
import type { HTMLAttributes, ReactNode } from 'react';

export type CardProps = Omit<HTMLAttributes<HTMLDivElement>, 'title'> & {
  title?: ReactNode;
  actions?: ReactNode;
  padded?: boolean;
};

export function Card({ title, actions, padded = true, className, children, ...rest }: CardProps) {
  return (
    <div
      className={classNames(
        'bg-raised border border-edge rd-14px',
        padded && 'p-16px',
        className
      )}
      style={{ boxShadow: 'var(--ocp-elev)' }}
      {...rest}
    >
      {title || actions ? (
        <div className={classNames('flex items-center justify-between', padded ? 'mb-12px' : 'p-16px pb-0')}>
          {typeof title === 'string' ? <h3 className="m-0 text-15px font-semibold text-ink">{title}</h3> : title}
          {actions ? <div className="flex items-center gap-8px">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </div>
  );
}
