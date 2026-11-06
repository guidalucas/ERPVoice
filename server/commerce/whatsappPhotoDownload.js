import { MAX_IMAGE_BYTES } from './imageProcessor.js';
import { fail } from './errors.js';

const supported = new Set(['image/jpeg', 'image/png', 'image/webp']);
const mediaHosts = new Set(['lookaside.fbsbx.com', 'lookaside.facebook.com', 'graph.facebook.com']);

export async function downloadWhatsAppPhoto(mediaId, phoneNumberId, { env = process.env, fetcher = fetch } = {}) {
  if (typeof mediaId !== 'string' || !/^[\w-]{1,200}$/.test(mediaId)) fail('IMAGE_META_ID_INVALID', 'WhatsApp no envió una foto válida.');
  const token = env.META_ACCESS_TOKEN;
  const version = env.META_GRAPH_API_VERSION || 'v21.0';
  if (!token || !/^v\d+\.\d+$/.test(version)) fail('IMAGE_META_UNAVAILABLE', 'La descarga de fotos de WhatsApp no está configurada.', 503);
  const metadataUrl = new URL(`https://graph.facebook.com/${version}/${mediaId}`);
  if (/^\d+$/.test(phoneNumberId ?? '')) metadataUrl.searchParams.set('phone_number_id', phoneNumberId);
  const get = async (url, timeout) => {
    try {
      const response = await fetcher(url, { headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(timeout) });
      if (response.ok) return response;
      await response.body?.cancel().catch(() => {});
      if (response.status === 404) fail('IMAGE_META_EXPIRED', 'La foto ya no está disponible en WhatsApp. Volvé a enviarla.');
    } catch (error) {
      if (error.code === 'IMAGE_META_EXPIRED') throw error;
    }
    fail('IMAGE_META_DOWNLOAD_FAILED', 'No pude descargar la foto de WhatsApp.', 503);
  };

  const metadata = await (await get(metadataUrl, 12_000)).json();
  const url = URL.canParse(metadata?.url) ? new URL(metadata.url) : null;
  if (!url || url.protocol !== 'https:' || url.port || url.username || url.password || !mediaHosts.has(url.hostname)) {
    fail('IMAGE_META_URL_INVALID', 'WhatsApp no devolvió una dirección válida para la foto.');
  }
  if (Number(metadata.file_size) > MAX_IMAGE_BYTES) fail('IMAGE_SIZE_INVALID', 'La foto debe pesar hasta 12 MB.');
  if (metadata.mime_type && !supported.has(metadata.mime_type)) fail('IMAGE_FORMAT_INVALID', 'Usá una foto JPG, PNG o WebP.');
  const response = await get(url, 20_000);
  if (!response.body) fail('IMAGE_META_DOWNLOAD_FAILED', 'No pude descargar la foto de WhatsApp.', 503);
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > MAX_IMAGE_BYTES) fail('IMAGE_SIZE_INVALID', 'La foto debe pesar hasta 12 MB.');
    chunks.push(chunk);
  }
  if (!length) fail('IMAGE_DECODE_FAILED', 'WhatsApp devolvió una foto vacía. Volvé a enviarla.');
  return Buffer.concat(chunks, length);
}
