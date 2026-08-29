import type { ReactNode } from 'react';
import { WaveformMark } from '../brand/WaveformMark';

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
      className="flex flex-col items-center justify-center rounded-[1.25rem] border border-dashed px-6 py-12 text-center"
      style={{ borderColor: 'var(--border)', background: 'var(--overlay-soft)' }}
    >
      <div
        className="mb-4 flex h-12 w-12 items-center justify-center rounded-[0.875rem] border"
        style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
      >
        {icon ?? <WaveformMark bars={5} />}
      </div>
      <h4 className="type-title text-lg text-[color:var(--text)]">{title}</h4>
      <p className="mt-2 max-w-sm text-sm leading-6 text-[color:var(--muted)]">{description}</p>
      {actionLabel && onAction && (
        <button type="button" className="erp-button-primary mt-5" onClick={onAction}>
          {actionLabel}
        </button>
      )}
    </div>
  );
}
