import test from 'node:test';
import assert from 'node:assert/strict';
import { createWebSessions } from '../web/server-sessions.js';
import { digest } from '../web/common.js';

test('web session store issues hashed cookie identities and resolves live sessions', () => {
  const loggedOut = [];
  const sessions = createWebSessions(60_000, (key) => loggedOut.push(key));
  const issued = sessions.issue();

  assert.match(issued.token, /^[A-Za-z0-9_-]{43}$/);
  assert.match(issued.csrf, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(issued.key, digest(issued.token));
  assert.equal(sessions.has(issued.token), false);
  assert.equal(sessions.size, 1);
  assert.equal(sessions.has(issued.key), true);
  assert.deepEqual(
    sessions.sessionFor({ headers: { cookie: `other=value; pis_web=${issued.token}` } }),
    { key: issued.key, csrf: issued.csrf, expires: sessions.get(issued.key).expires },
  );
  assert.deepEqual(loggedOut, []);

  sessions.logout(issued.key);
  assert.equal(sessions.has(issued.key), false);
  assert.deepEqual(loggedOut, [issued.key]);
});

test('web session store expires at the deadline without removing live sessions', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const loggedOut = [];
  const sessions = createWebSessions(100, (key) => loggedOut.push(key));
  const expired = sessions.issue();
  t.mock.timers.tick(50);
  const live = sessions.issue();
  t.mock.timers.tick(50);

  sessions.expire();
  assert.equal(sessions.size, 1);
  assert.equal(sessions.has(expired.key), false);
  assert.equal(sessions.has(live.key), true);
  assert.deepEqual(loggedOut, [expired.key]);
  sessions.expire();
  assert.deepEqual(loggedOut, [expired.key]);
});

test('cookie lookup rejects malformed, unknown and expired tokens without logout callbacks', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const loggedOut = [];
  const sessions = createWebSessions(100, (key) => loggedOut.push(key));
  const issued = sessions.issue();
  for (const cookie of [
    undefined,
    'pis_web=short',
    `pis_web=${issued.token}extra`,
    `pis_web=${'a'.repeat(43)}`,
  ]) {
    assert.equal(sessions.sessionFor({ headers: { cookie } }), undefined);
  }
  assert.equal(sessions.size, 1);
  t.mock.timers.tick(100);
  assert.equal(sessions.sessionFor({ headers: { cookie: `pis_web=${issued.token}` } }), undefined);
  assert.equal(sessions.size, 0);
  // Preserve lookup's lazy deletion; explicit logout/expiry owns peer/ticket cleanup.
  assert.deepEqual(loggedOut, []);
});

test('shutdown clear drops all sessions without logout callbacks', () => {
  const loggedOut = [];
  const sessions = createWebSessions(60_000, (key) => loggedOut.push(key));
  sessions.issue();
  sessions.issue();
  sessions.clear();
  assert.equal(sessions.size, 0);
  assert.deepEqual(loggedOut, []);
});
