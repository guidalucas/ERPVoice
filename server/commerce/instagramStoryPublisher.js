export function createInstagramStoryPublisher({ version = 'v26.0', fetchImpl = fetch } = {}) {
  if (!/^v\d+\.0$/.test(version)) throw new Error('META_VERSION_INVALID');
  const graph = 'https://graph.instagram.com';
  async function request(path, token, form, query = {}) {
    const url = new URL(path, graph);
    url.search = new URLSearchParams(query);
    try {
      const response = await fetchImpl(url, {
        method: form ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}` },
        body: form && new URLSearchParams(form), redirect: 'error', signal: AbortSignal.timeout(12_000),
      });
      const data = await response.json().catch(() => null);
      if (response.ok && data && !data.error) return data;
      if (data?.error?.code === 190) {
        throw new Error(data.error.error_subcode === 463 ? 'META_TOKEN_EXPIRED' : 'META_TOKEN_REVOKED');
      }
      if ([10, 200, 299].includes(data?.error?.code)) throw new Error('META_PERMISSION_DENIED');
      throw new Error(response.status === 429 ? 'META_RATE_LIMIT' : 'META_REQUEST_FAILED');
    } catch (error) {
      if (/^META_[A-Z_]+$/.test(error?.message)) throw error;
      throw new Error('META_UNREACHABLE');
    }
  }
  const id = value => {
    if (typeof value !== 'string' || !/^\d{1,32}$/.test(value)) throw new Error('META_INVALID_RESPONSE');
    return value;
  };
  return {
    account: async token => {
      const result = await request(`/${version}/me`, token, null, { fields: 'user_id,username,account_type' });
      const account = result.data?.[0] ?? result;
      if (String(account.account_type).toLowerCase() !== 'business') throw new Error('META_BUSINESS_ACCOUNT_REQUIRED');
      if (typeof account.username !== 'string' || !/^[a-z0-9._]{1,30}$/i.test(account.username)) throw new Error('META_INVALID_RESPONSE');
      return { id: id(account.user_id), username: account.username };
    },
    verifyPublishing: (token, account) => request(`/${version}/${id(account)}/content_publishing_limit`, token, null, { fields: 'quota_usage,config' }),
    refresh: token => request('/refresh_access_token', token, null, { grant_type: 'ig_refresh_token', access_token: token }),
    create: async (token, account, imageUrl) => id((await request(`/${version}/${id(account)}/media`, token, {
      image_url: imageUrl, media_type: 'STORIES',
    })).id),
    status: async (token, container) => (await request(`/${version}/${id(container)}`, token, null, { fields: 'status_code' })).status_code,
    publish: async (token, account, container) => id((await request(`/${version}/${id(account)}/media_publish`, token,
      { creation_id: id(container) })).id),
  };
}
