import { useMetaEventSync } from '../../hooks/useMetaEventSync';

export function MetaSyncBridge() {
  useMetaEventSync();
  return null;
}