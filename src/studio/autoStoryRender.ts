import { renderStory, type StorySnapshot } from './storyRenderer';

export type AutoStoryPayload = { status: 'rendering'; id: string; snapshot: StorySnapshot; photo: string;
  logo: { type: string; bytes: string } | null };

function decode(bytes: string, type: string) {
  return new Blob([Uint8Array.from(atob(bytes), char => char.charCodeAt(0))], { type });
}

export function renderAutoStory({ snapshot, photo, logo }: AutoStoryPayload) {
  return renderStory(document.createElement('canvas'), snapshot, decode(photo, 'image/jpeg'), 'jpeg', async () => {
    if (!logo) throw new Error('El logo de la historia no está disponible.');
    return decode(logo.bytes, logo.type);
  });
}
