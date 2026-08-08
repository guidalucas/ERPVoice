type StockyLogoProps = {
  size?: 'sm' | 'md' | 'lg';
  className?: string;
  withWordmark?: boolean;
  subtitle?: string;
};

const sizeClass: Record<NonNullable<StockyLogoProps['size']>, string> = {
  sm: 'h-8 w-8',
  md: 'h-10 w-10',
  lg: 'h-14 w-14',
};

export function StockyLogo({ size = 'md', className = '', withWordmark = false, subtitle }: StockyLogoProps) {
  const mark = (
    <img
      src="/stocky-logo.png"
      alt={withWordmark ? '' : 'Stocky'}
      width={size === 'lg' ? 56 : size === 'sm' ? 32 : 40}
      height={size === 'lg' ? 56 : size === 'sm' ? 32 : 40}
      className={`${sizeClass[size]} shrink-0 rounded-2xl object-cover ${className}`}
      decoding="async"
    />
  );

  if (!withWordmark) {
    return mark;
  }

  return (
    <div className="flex items-center gap-3">
      {mark}
      <div className="min-w-0">
        <p className="font-display text-sm font-bold tracking-tight text-slate-900 dark:text-white">Stocky</p>
        {subtitle ? <p className="truncate text-xs text-slate-600 dark:text-slate-400">{subtitle}</p> : null}
      </div>
    </div>
  );
}
