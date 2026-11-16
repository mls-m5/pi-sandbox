import { randomUUID, randomInt } from 'node:crypto';

// Host wrapper IPC only. Nothing on this channel is mounted in the sandbox.
export function createWebGitApproval(channel, { lifetimeMs = 300000 } = {}) {
  let pending,
    lastId,
    disposed = false;
  function finish(approved) {
    const entry = pending;
    if (!entry) return;
    pending = undefined;
    clearTimeout(entry.timer);
    entry.resolve(approved);
  }
  const receive = (value) => {
    if (!pending || value?.type !== 'web_git_decision' || value.id !== pending.id) return;
    const approved =
      Object.keys(value).sort().join(',') === 'approved,code,id,type' &&
      value.approved === true &&
      value.code === pending.code &&
      Date.now() < pending.expiresAt;
    finish(approved); // Wrong code/repeat is never another attempt against the same approval.
  };
  const disconnect = () => {
    disposed = true;
    finish(false);
  };
  channel.on('message', receive);
  channel.on('disconnect', disconnect);
  return {
    approve(push) {
      if (disposed || pending || !channel.connected) return Promise.resolve(false);
      const id = randomUUID(),
        code = String(randomInt(10, 100)),
        expiresAt = Date.now() + lifetimeMs;
      lastId = id;
      return new Promise((resolve) => {
        pending = {
          id,
          code,
          expiresAt,
          resolve,
          timer: setTimeout(() => finish(false), lifetimeMs),
        };
        try {
          channel.send(
            {
              type: 'web_git_proposal',
              proposal: {
                id,
                code,
                expiresAt,
                repo: push.repo,
                remote: push.remote,
                url: push.url,
                commit: push.commit,
                ref: push.ref,
                reason: push.reason,
              },
            },
            (error) => {
              if (error) finish(false);
            },
          );
        } catch {
          finish(false);
        }
      });
    },
    report(phase) {
      if (lastId && channel.connected && ['succeeded', 'unknown', 'declined'].includes(phase))
        try {
          channel.send({ type: 'web_git_outcome', id: lastId, phase }, () => {});
        } catch {}
    },
    dispose() {
      disconnect();
      channel.off('message', receive);
      channel.off('disconnect', disconnect);
    },
  };
}
