type WaveformMarkProps = {
  className?: string;
  bars?: number;
};

const BAR_HEIGHTS = [7, 13, 8, 16, 6, 12, 5];

export function WaveformMark({ className = '', bars = 5 }: WaveformMarkProps) {
  return (
    <span className={`inline-flex items-end gap-[3px] text-[color:var(--accent)] ${className}`} aria-hidden="true">
      {BAR_HEIGHTS.slice(0, bars).map((height, index) => (
        <span
          key={index}
          className="waveform-bar"
          style={{ height: `${height}px`, animationDelay: `${index * 80}ms` }}
        />
      ))}
    </span>
  );
}
