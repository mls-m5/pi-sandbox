// Container-only compatibility for extensions with a hard-coded Codex usage URL.
// The host still authenticates the dummy capability and controls the upstream.
export function usageProxyRequest(input, init, env = process.env) {
  if (env.PIS_PROXY_PROVIDER !== 'openai-codex') return undefined;
  const request = new Request(input, init);
  if (request.url !== 'https://chatgpt.com/backend-api/wham/usage' || request.method !== 'GET') return undefined;
  if (!env.PIS_PROXY_TOKEN || request.headers.get('authorization') !== `Bearer ${env.PIS_PROXY_TOKEN}`) throw new Error('Codex usage requires the sandbox proxy capability.');
  const base = new URL(env.PIS_PROXY_BASE_URL);
  if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || base.port !== '43127') throw new Error('Invalid sandbox proxy endpoint.');
  const redirected = new Request(`${base.origin}/backend-api/wham/usage`, request);
  redirected.headers.delete('host');
  redirected.headers.delete('chatgpt-account-id');
  return redirected;
}

if (process.env.PIS_PROXY_PROVIDER === 'openai-codex') {
  const originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (input, init) => {
    const redirected = usageProxyRequest(input, init);
    return redirected ? originalFetch(redirected) : originalFetch(input, init);
  };
}
