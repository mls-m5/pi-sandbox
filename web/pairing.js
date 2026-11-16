import { randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { budget, digest, randomKey } from './common.js';

export const PAIRING_MS = 120_000;
const invalid = () => ({ status: 403, error: 'pairing_invalid' });
const equalHash = (a, b) => timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));

// No sockets or plaintext bearer proofs/connection keys are retained here.
export function createPairing({ sessionExpires, enroll, onChange, lifetime = PAIRING_MS }) {
  const requests = new Map(),
    attempts = new Map();
  const creationBudget = budget(10, 60_000),
    approvalBudget = budget(10, 60_000);
  function snapshot() {
    return [...requests.values()]
      .filter((entry) => !entry.owner)
      .map(({ id, label, kind, expiresAt }) => ({ id, label, kind, expiresAt }));
  }
  const changed = () => onChange(snapshot());
  function expire() {
    let removed = false;
    for (const [id, entry] of requests)
      if (
        entry.expiresAt <= Date.now() ||
        (entry.owner && (sessionExpires(entry.owner) || 0) <= Date.now())
      ) {
        requests.delete(id);
        removed = true;
      }
    for (const [owner] of attempts)
      if ((sessionExpires(owner) || 0) <= Date.now()) attempts.delete(owner);
    if (removed) changed();
  }
  return {
    snapshot() {
      expire();
      return snapshot();
    },
    allowCreate() {
      expire();
      return creationBudget() && requests.size < 32;
    },
    create(value) {
      expire();
      if (requests.size >= 32) return { status: 429, error: 'pairing_limit' };
      const used = new Set([...requests.values()].map((entry) => entry.code));
      const available = Array.from({ length: 100 }, (_, i) => String(i).padStart(2, '0')).filter(
        (code) => !used.has(digest(code)),
      );
      const id = randomUUID(),
        token = randomKey(),
        code = available[randomInt(available.length)];
      const expiresAt = Date.now() + lifetime;
      requests.set(id, {
        id,
        label: value.label,
        kind: value.kind,
        clientId: value.clientId,
        proof: value.previousToken ? digest(value.previousToken) : null,
        capability: digest(token),
        code: digest(code),
        expiresAt,
        checks: 0,
        owner: null,
      });
      changed();
      return { id, token, code, expiresAt };
    },
    allowApproval(owner) {
      expire();
      if (!attempts.has(owner)) attempts.set(owner, budget(5, 60_000));
      // Unknown IDs and malformed bodies consume the same budgets as real guesses.
      const local = attempts.get(owner)(),
        global = approvalBudget();
      return local && global;
    },
    approve(id, code, owner) {
      expire();
      const entry = requests.get(id);
      if (!entry || entry.owner || (sessionExpires(owner) || 0) <= Date.now()) return invalid();
      entry.checks++;
      if (!equalHash(entry.code, digest(code))) {
        if (entry.checks >= 3) {
          requests.delete(id);
          changed();
        }
        return invalid();
      }
      entry.owner = owner;
      changed();
      return { ok: true };
    },
    claim(id, token) {
      expire();
      const entry = requests.get(id);
      if (!entry || !equalHash(entry.capability, digest(token))) return invalid();
      if (!entry.owner) return { status: 202, pending: true };
      // No await from live-session/proof validation to consumption and registration.
      requests.delete(id);
      const result = enroll(
        { clientId: entry.clientId, label: entry.label, kind: entry.kind },
        entry.proof,
      );
      changed();
      return result;
    },
    clearOwner(owner) {
      attempts.delete(owner);
      let removed = false;
      for (const [id, entry] of requests)
        if (entry.owner === owner) {
          requests.delete(id);
          removed = true;
        }
      if (removed) changed();
    },
    expire,
    clear() {
      requests.clear();
      attempts.clear();
    },
  };
}
