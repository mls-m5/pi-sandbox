export function fakeCodexAccess({ accountId = 'host-account-only', expires = Math.floor(Date.now() / 1000) + 3600, signature = 'fake-signature-not-a-real-token' } = {}) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ exp: expires, 'https://api.openai.com/auth': { chatgpt_account_id: accountId } })}.${signature}`;
}

export function fakeCodexCredential(options = {}) {
  return { type: 'oauth', access: fakeCodexAccess(options), refresh: 'fake-private-refresh-token', expires: (options.expires || Math.floor(Date.now() / 1000) + 3600) * 1000, accountId: options.accountId || 'host-account-only' };
}
