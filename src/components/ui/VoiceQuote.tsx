import { WaveformMark } from '../brand/WaveformMark';

type VoiceQuoteProps = {
  text: string;
  clamp?: boolean;
};

export function VoiceQuote({ text, clamp = true }: VoiceQuoteProps) {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  return (
    <div className="voice-quote">
      <WaveformMark className="self-start pt-0.5" bars={5} />
      <p className={`voice-quote-text ${clamp ? 'line-clamp-3' : ''}`}>“{trimmed}”</p>
    </div>
  );
}
