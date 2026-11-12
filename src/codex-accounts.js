// Host-only routing. Named OAuth credentials never cross the proxy capability.
import { readCodexAccountsPolicy, getCodexCredential, fetchCodexUsage, useCodexAccount, codexClaims } from './codex-auth.js';
import { codexAvailability } from './codex-usage.js';

export function createCodexAccountRouter(store, { fetchImpl, now = Date.now, cacheMs = 60_000, notify = console.error } = {}) {
  const cache = new Map();
  async function checked(account, signal) {
    const credential = await getCodexCredential(store, { account, signal, fetchImpl });
    let entry = cache.get(account);
    if (!entry || entry.access !== credential.access || entry.until <= now() || (entry.pending && entry.signal !== signal)) {
      const task = fetchCodexUsage(credential, { signal, fetchImpl }).then(usage => ({ usage, available: codexAvailability(usage, now()).available }));
      entry = { access: credential.access, identity: codexClaims(credential.access).identity, until: now() + cacheMs, task, signal, pending: true };
      if (!cache.has(account) && cache.size >= 32) cache.delete(cache.keys().next().value);
      cache.set(account, entry);
      // Cancelled checks aren't retained; other failures get a short backoff.
      void task.then(() => { entry.pending = false; }, () => {
        entry.pending = false;
        if (cache.get(account) !== entry) return;
        if (signal?.aborted) cache.delete(account); else entry.until = now() + 5000;
      });
    }
    const result = await entry.task;
    signal?.throwIfAborted();
    return { ...result, credential, account };
  }
  async function select(signal, requireAvailable, allowSwitch = true) {
    let bounded = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      signal?.throwIfAborted();
      const policy = readCodexAccountsPolicy(store);
      if (!policy.pool.includes(policy.active)) {
        const credential = await getCodexCredential(store, { account: policy.active, signal, fetchImpl });
        if (readCodexAccountsPolicy(store).revision !== policy.revision) continue;
        return { account: policy.active, credential };
      }
      if (!bounded) {
        signal = AbortSignal.any([AbortSignal.timeout(60_000), ...(signal ? [signal] : [])]); bounded = true;
      }
      const current = await checked(policy.active, signal);
      if (readCodexAccountsPolicy(store).revision !== policy.revision) continue;
      if (current.available) return current;
      const limit = current.usage.rate_limit;
      const exhausted = limit.limit_reached === true || [limit.primary_window, limit.secondary_window].some(window => window?.used_percent >= 100);
      if (!exhausted) {
        if (requireAvailable) throw new Error('Codex account denied without confirmed quota exhaustion.');
        return current;
      }
      if (!allowSwitch) throw Object.assign(new Error('Cannot move account-bound server state to another profile.'), { code: 'PIS_CODEX_STATEFUL' });
      // Only confirmed subscription exhaustion authorizes looking at another
      // explicitly enrolled profile. Unknown/auth/network errors never do.
      const seen = new Set([codexClaims(current.credential.access).identity]);
      let retry = false;
      const index = policy.pool.indexOf(policy.active);
      for (let offset = 1; offset < policy.pool.length; offset++) {
        const account = policy.pool[(index + offset) % policy.pool.length];
        let candidate;
        try {
          candidate = await checked(account, signal);
          const identity = codexClaims(candidate.credential.access).identity;
          if (seen.has(identity)) continue;
          seen.add(identity);
        } catch { signal?.throwIfAborted(); continue; }
        if (!candidate.available) continue;
        const changed = await useCodexAccount(store, account, { expectedRevision: policy.revision, expectedCredential: candidate.credential, signal });
        if (!changed) { retry = true; break; } // Manual changes or a concurrent refresh win.
        try { notify(`pis: Codex quota exhausted; switched host profile ${policy.active} → ${account}.`); } catch { /* No logging failure may replay a request. */ }
        return candidate;
      }
      if (retry || readCodexAccountsPolicy(store).revision !== policy.revision) continue;
      if (requireAvailable) throw Object.assign(new Error('No verified available Codex account in the configured pool.'), { code: 'PIS_CODEX_QUOTA' });
      return current;
    }
    throw new Error('Codex account selection changed concurrently; retry explicitly.');
  }
  return {
    async credentials(signal, request) {
      if (request?.method !== 'POST') return { apiKey: (await getCodexCredential(store, { signal, fetchImpl })).access };
      const chosen = await select(signal, true, !request.stateful);
      return { apiKey: chosen.credential.access };
    },
    async usage({ signal } = {}) {
      const result = await select(signal, false);
      return result.usage || fetchCodexUsage(result.credential, { signal, fetchImpl });
    },
    invalidate({ status, credential }) {
      if (status !== 429) return;
      for (const [account, entry] of cache) if (entry.access === credential.apiKey || (credential.identity && entry.identity === credential.identity)) cache.delete(account);
      // Never replay or switch based on an HTTP status alone. The next request
      // must freshly confirm subscription exhaustion with the fixed usage API.
    },
  };
}

export async function getRoutedCodexUsage(store, options = {}) {
  // Quota wait polls require fresh evidence, not a previous process's cache.
  return createCodexAccountRouter(store, { fetchImpl: options.fetchImpl, cacheMs: 0 }).usage(options);
}
