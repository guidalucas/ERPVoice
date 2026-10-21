import { fail } from './errors.js';
/** Preparation only: no environment switch, credentials, HTTP client or publishing side effects. */
export const metaPublishingPreparation = Object.freeze({ version: 1, status: 'disabled', mode: 'manual_export_only', reviewedAt: '2026-10-20',
  candidateInstagramLoginScopes: Object.freeze(['instagram_business_basic', 'instagram_business_content_publish']),
  externalGates: Object.freeze(['explicit_publication_authorization', 'verified_professional_account_and_story_capability',
    'approved_app_and_minimal_permissions', 'secure_token_lifecycle', 'verified_media_delivery_and_format', 'current_api_version_limits_and_idempotency']),
  officialReference: 'https://www.postman.com/meta/instagram/overview' });
export function requireMetaPublishing() { fail('META_PUBLICATION_DISABLED', 'La publicación automática no está habilitada. Exportá la historia para compartirla manualmente.', 503); }
