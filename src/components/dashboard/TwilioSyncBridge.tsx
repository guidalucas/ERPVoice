import { useTwilioEventSync } from '../../hooks/useTwilioEventSync';

export function TwilioSyncBridge() {
  useTwilioEventSync();
  return null;
}