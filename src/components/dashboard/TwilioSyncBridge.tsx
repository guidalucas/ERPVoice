import { useMetaEventSync } from '../../hooks/useTwilioEventSync';

export function MetaSyncBridge() {
  useMetaEventSync();
  return null;
}