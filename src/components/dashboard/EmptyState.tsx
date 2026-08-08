import type { ReactNode } from 'react';

type EmptyStateProps = {
  title: string;
  description: string;
  actionLabel?: string;
  onAction?: () => void;
  icon?: ReactNode;
};

export function EmptyState({ title, description, actionLabel, onAction, icon }: EmptyStateProps) {
  return (
    <div
      className="flex flex-col items-center justify-center rounded-2xl border border-dashed px-6 py-10 text-center"
      style={{ borderColor: 'var(--border)', background: 'var(--overlay-soft)' }}
    >
      {icon && (
        <div
          className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl border text-slate-500 dark:text-slate-400"
          style={{ borderColor: 'var(--border)', background: 'var(--overlay-soft)' }}
        >
          {icon}
        </div>
      )}
      <h4 className="font-display text-lg font-bold text-slate-900 dark:text-slate-100">{title}</h4>
      <p className="mt-2 max-w-sm text-sm leading-6 text-slate-600 dark:text-slate-400">{description}</p>
      {actionLabel && onAction && (
        <button type="button" className="erp-button-primary mt-5" onClick={onAction}>
          {actionLabel}
        </button>
      )}
    </div>
  );
}
