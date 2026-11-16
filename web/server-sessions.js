import { digest, randomKey } from './common.js';

export function createWebSessions(sessionMs, onLogout) {
  const sessions = new Map();

  function logout(key) {
    sessions.delete(key);
    onLogout(key);
  }

  return {
    get size() {
      return sessions.size;
    },
    get(key) {
      return sessions.get(key);
    },
    has(key) {
      return sessions.has(key);
    },
    clear() {
      sessions.clear();
    },
    sessionFor(req) {
      const match = /(?:^|;\s*)pis_web=([A-Za-z0-9_-]{43})(?:;|$)/.exec(req.headers.cookie || '');
      if (!match) return;
      const key = digest(match[1]);
      const session = sessions.get(key);
      if (!session || session.expires <= Date.now()) {
        sessions.delete(key);
        return;
      }
      return { ...session, key };
    },
    issue() {
      const token = randomKey();
      const csrf = randomKey();
      const key = digest(token);
      sessions.set(key, { csrf, expires: Date.now() + sessionMs });
      return { token, csrf, key };
    },
    logout,
    expire() {
      for (const [key, session] of sessions) if (session.expires <= Date.now()) logout(key);
    },
  };
}
