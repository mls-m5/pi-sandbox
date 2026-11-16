import { randomUUID } from 'node:crypto';
import { validateGitPushProposal, validatePushUrl } from '../src/git-push.js';
import { exact, generationValid } from './common.js';
export function validateWebPush(value) {
  if (
    !exact(value, [
      'id',
      'code',
      'expiresAt',
      'repo',
      'remote',
      'url',
      'commit',
      'ref',
      'reason',
    ]) ||
    !generationValid(value.id) ||
    !/^\d{2}$/.test(value.code) ||
    !Number.isSafeInteger(value.expiresAt) ||
    value.expiresAt <= Date.now() ||
    value.expiresAt > Date.now() + 301000
  )
    throw new Error('Invalid host push.');
  const p = validateGitPushProposal({
    type: 'git-push',
    repo: value.repo,
    remote: value.remote,
    commit: value.commit,
    ref: value.ref,
    reason: value.reason,
  });
  const url = validatePushUrl(value.url);
  if (url !== value.url) throw new Error('Invalid push destination.');
  return {
    id: value.id,
    code: value.code,
    expiresAt: value.expiresAt,
    repo: p.repo,
    remote: p.remote,
    commit: p.commit,
    ref: p.ref,
    reason: p.reason,
    url,
  };
}
// Bounded, ephemeral approval routing. A review nonce belongs to one live browser.
export function createHostPushes({ send, broadcast }) {
  const entries = new Map();
  const publish = (entry) =>
    broadcast(entry.peer.agentId, {
      v: 1,
      type: 'host_push',
      agentId: entry.peer.agentId,
      generation: entry.generation,
      push: { ...entry.proposal, phase: entry.phase },
    });
  const current = (peer, id) => {
    const e = entries.get(peer.agentId);
    return e?.peer === peer && e.proposal.id === id ? e : null;
  };
  return {
    announce(peer, value) {
      const proposal = validateWebPush(value),
        previous = entries.get(peer.agentId);
      if (previous?.peer === peer) throw new Error('Only one host push per runtime.');
      const entry = { peer, generation: peer.generation, proposal, phase: 'pending' };
      entries.set(peer.agentId, entry);
      publish(entry);
    },
    snapshot(ws, agentId) {
      const e = entries.get(agentId);
      if (e)
        send(ws, {
          v: 1,
          type: 'host_push',
          agentId,
          generation: e.generation,
          push: { ...e.proposal, phase: e.phase },
        });
    },
    review(ws, peer, value) {
      const e = current(peer, value.id);
      if (
        !e ||
        e.phase !== 'pending' ||
        e.generation !== value.generation ||
        e.proposal.expiresAt <= Date.now() ||
        (e.owner && e.owner !== ws)
      )
        return;
      e.owner = ws;
      e.reviewId = randomUUID();
      send(ws, {
        v: 1,
        type: 'host_push_review',
        agentId: peer.agentId,
        generation: e.generation,
        id: e.proposal.id,
        reviewId: e.reviewId,
      });
    },
    decide(ws, peer, value) {
      const e = current(peer, value.id);
      if (
        !e ||
        e.owner !== ws ||
        e.reviewId !== value.reviewId ||
        e.generation !== value.generation ||
        e.phase !== 'pending' ||
        e.proposal.expiresAt <= Date.now()
      )
        return;
      e.reviewId = undefined;
      e.owner = undefined;
      const approved = value.approved === true && value.code === e.proposal.code;
      e.phase = approved ? 'pushing' : 'declined';
      if (
        !send(peer, {
          v: 1,
          type: 'host_push_decision',
          generation: e.generation,
          id: e.proposal.id,
          approved,
          code: approved ? value.code : '',
        })
      )
        e.phase = 'unknown';
      publish(e);
    },
    outcome(peer, id, phase) {
      const e = current(peer, id);
      if (!e || !['succeeded', 'unknown', 'declined'].includes(phase)) return;
      if (phase === 'succeeded' && e.phase !== 'pushing')
        throw new Error('Unapproved push result.');
      e.phase = phase;
      publish(e);
    },
    release(ws) {
      for (const e of entries.values())
        if (e.owner === ws) {
          e.owner = undefined;
          e.reviewId = undefined;
        }
    },
    disconnect(peer) {
      const e = entries.get(peer.agentId);
      if (e?.peer === peer && ['pending', 'pushing'].includes(e.phase)) {
        e.phase = 'unknown';
        e.owner = undefined;
        e.reviewId = undefined;
        publish(e);
      }
    },
    expire() {
      for (const e of entries.values())
        if (e.phase === 'pending' && e.proposal.expiresAt <= Date.now()) {
          e.phase = 'expired';
          e.owner = undefined;
          e.reviewId = undefined;
          publish(e);
        }
    },
    forget(id) {
      entries.delete(id);
    },
    clear() {
      entries.clear();
    },
  };
}
