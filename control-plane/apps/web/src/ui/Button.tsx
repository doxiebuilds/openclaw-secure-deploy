import classNames from 'classnames';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

type Variant = 'primary' | 'default' | 'text' | 'danger';
type Size = 'sm' | 'md' | 'lg';

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
  icon?: ReactNode;
  loading?: boolean;
};

const variantClass: Record<Variant, string> = {
  primary: 'bg-accent text-ink-on border-transparent hover:brightness-110 active:brightness-95',
  default: 'bg-raised text-ink border-edge hover:bg-hover active:bg-press',
  text: 'bg-transparent text-ink-2 border-transparent hover:bg-hover active:bg-press',
  danger:
    'bg-transparent text-bad border-[var(--ocp-bad-edge)] hover:bg-[var(--ocp-bad-soft)] active:bg-[var(--ocp-bad-soft)]',
};

const sizeClass: Record<Size, string> = {
  sm: 'h-28px px-10px text-13px gap-4px rd-8px',
  md: 'h-34px px-14px text-14px gap-6px rd-10px',
  lg: 'h-40px px-18px text-15px gap-8px rd-10px',
};

export function Button({
  variant = 'default',
  size = 'md',
  icon,
  loading,
  disabled,
  className,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      type="button"
      className={classNames(
        'inline-flex items-center justify-center border font-medium cursor-pointer select-none',
        'transition-colors duration-150 ease-out',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        variantClass[variant],
        sizeClass[size],
        className
      )}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? (
        <span
          className="inline-block size-14px border-2 border-t-transparent border-current rd-full"
          style={{ animation: 'ocp-spin 0.7s linear infinite' }}
        />
      ) : (
        icon
      )}
      {children}
    </button>
  );
}
