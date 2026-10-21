import { command } from './api';
import type { StorySnapshot } from './storyRenderer';
export async function reportExport(snapshot: StorySnapshot, blob: Blob, filename: string, kind: 'generated' | 'download_requested' | 'share_requested') {
  const hash = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return command(`/story-snapshots/${snapshot.snapshotId}/export-events`, 'POST', { kind, filename, mimeType: blob.type, sizeBytes: blob.size,
    sha256: Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, '0')).join('') });
}
