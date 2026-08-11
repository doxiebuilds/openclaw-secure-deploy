import classNames from 'classnames';
import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';

// Prefer explicit border-color tokens via var(). Utility names like `border-edge`
// can be ambiguous in UnoCSS (border-side width vs theme color).
const fieldBase =
  'w-full rd-10px border border-solid border-[var(--ocp-edge)] bg-raised text-ink px-12px py-8px text-14px ' +
  'transition-colors duration-150 placeholder:text-ink-3 ' +
  'hover:border-[var(--ocp-well)] focus:border-accent focus:outline-none';

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={classNames(fieldBase, className)} {...rest} />;
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={classNames(fieldBase, 'resize-y min-h-96px', className)} {...rest} />;
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={classNames(fieldBase, 'cursor-pointer', className)} {...rest}>
      {children}
    </select>
  );
}

export function Label({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-6px">
      <span className="text-13px text-ink-2 font-medium">{label}</span>
      {children}
    </label>
  );
}
