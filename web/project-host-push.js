import { EventEmitter } from 'node:events';
import { validateWebPush } from './host-push.js';

// Trusted local wrapper, not Pi stdout, supplies a verified stopped-container proposal.
export function createProjectHostPush(child, rpc) {
  const events = new EventEmitter();
  let pending,
    outcomeReceived = false,
    restartReady = false,
    decided = false;
  const cancel = () => {
    if (pending && !decided) {
      decided = true;
      if (child.connected)
        try {
          child.send(
            { type: 'web_git_decision', id: pending.id, approved: false, code: '' },
            () => {},
          );
        } catch {}
    }
  };
  const receive = (value) => {
    try {
      if (value?.type === 'web_git_proposal') {
        if (pending) throw new Error();
        pending = validateWebPush(value.proposal);
        rpc.fault('host_approval_pending');
        events.emit('proposal', pending);
      } else if (
        value?.type === 'web_git_outcome' &&
        pending?.id === value.id &&
        ['succeeded', 'unknown', 'declined'].includes(value.phase)
      ) {
        outcomeReceived = true;
        events.emit('outcome', { id: value.id, phase: value.phase });
      } else if (
        value?.type === 'web_git_restart_ready' &&
        Object.keys(value).length === 2 &&
        pending?.id === value.id &&
        outcomeReceived
      ) {
        restartReady = true;
      }
    } catch {
      if (
        !pending &&
        value?.type === 'web_git_proposal' &&
        typeof value.proposal?.id === 'string' &&
        /^[a-f0-9-]{36}$/.test(value.proposal.id) &&
        child.connected
      ) {
        try {
          child.send(
            { type: 'web_git_decision', id: value.proposal.id, approved: false, code: '' },
            () => {},
          );
        } catch {}
      }
      cancel();
    }
  };
  child.on('message', receive);
  return {
    events,
    get restartReady() {
      return restartReady;
    },
    cancel,
    decide(value) {
      if (!pending || decided || value.id !== pending.id || pending.expiresAt <= Date.now()) return;
      decided = true;
      if (child.connected)
        try {
          child.send(
            {
              type: 'web_git_decision',
              id: pending.id,
              approved: value.approved === true,
              code: value.code,
            },
            (error) => {
              if (error) events.emit('outcome', { id: pending.id, phase: 'unknown' });
            },
          );
        } catch {
          events.emit('outcome', { id: pending.id, phase: 'unknown' });
        }
    },
    close() {
      cancel();
      child.off('message', receive);
    },
  };
}
