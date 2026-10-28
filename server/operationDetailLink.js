const DEFAULT_APP_URL = 'https://erp-voice.vercel.app';

export function operationDetailUrl(draftId, appUrl = process.env.PUBLIC_APP_URL || process.env.APP_URL || DEFAULT_APP_URL) {
  if (typeof draftId !== 'string' || !draftId.trim() || draftId.length > 180) return null;
  try {
    const url = new URL(appUrl);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    url.search = '';
    url.hash = '';
    url.searchParams.set('operation', draftId);
    return url.href.length <= 600 ? url.href : null;
  } catch { return null; }
}
