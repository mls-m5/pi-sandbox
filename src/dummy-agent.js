// Explicit offline simulator. No Pi CLI, provider transport, auth or model call.
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startCodexAutoServer } from './codex-auto.js';
import { AUTO_RESUME_NOTICE, isCodexQuotaError, requestCodexWait } from './runtime/codex-auto.mjs';

export const DUMMY_TEXT = '[dummy] Lorem ipsum dolor sit amet, consectetur adipiscing elit. This is a simulated reply; no model tokens were used.';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export async function createDummyAgent(send, { autoResume = false, chunkMs = 20, pollMs = 250 } = {}) {
  const sessionId = randomUUID(), messages = [];
  let historyBytes = 0, leaf = 0, epoch = 0, active, pending, closed = false, exhaustedUntil = 0, closing;
  let resumes = 0, lastStatus;
  const output = record => { if (!closed) send(record); };
  const status = state => {
    if (state === lastStatus) return;
    lastStatus = state;
    output({ type: 'dummy_status', state, simulated: true });
  };
  const usage = async () => {
    const exhausted = Date.now() < exhaustedUntil;
    return { rate_limit: { allowed: !exhausted, limit_reached: exhausted, primary_window: { used_percent: exhausted ? 100 : 0, reset_after_seconds: Number.isFinite(exhaustedUntil) ? Math.max(0, (exhaustedUntil - Date.now()) / 1000) : 300 } } };
  };
  // Real host wait protocol/availability decisions, but exclusively synthetic usage
  // and a shorter injected sleep. Production timers and auth remain untouched.
  const service = await startCodexAutoServer({}, { usage, routeUsage: usage, sleep: (ms, value, options) => delay(Math.min(ms, pollMs), value, options), minCheckInterval: 0 });
  const append = message => {
    messages.push(message); historyBytes += Buffer.byteLength(JSON.stringify(message)); leaf++;
    while (messages.length > 100 || historyBytes > 512 * 1024) historyBytes -= Buffer.byteLength(JSON.stringify(messages.shift()));
  };
  const cancel = () => {
    epoch++;
    if (pending) { pending.controller.abort(); pending = undefined; status('cancelled'); }
  };
  const wait = () => {
    if (!autoResume || closed || active || pending) return;
    const task = { controller: new AbortController(), epoch, leaf };
    pending = task;
    task.promise = (async () => {
      try {
        const state = await requestCodexWait(path.join(service.directory, 'wait.sock'), {
          signal: task.controller.signal, onWaiting: () => { if (pending === task) status('waiting'); },
        });
        if (pending !== task || task.controller.signal.aborted || closed) return;
        pending = undefined;
        if (state === 'ready' && autoResume && !active && epoch === task.epoch && leaf === task.leaf) {
          status('ready'); resumes++;
          startTurn(AUTO_RESUME_NOTICE);
        } else status(state === 'not-quota' ? 'not_quota' : 'wait_error');
      } catch { if (pending === task) { pending = undefined; status('wait_error'); } }
    })();
    void task.promise.catch(() => { void close(); });
  };
  function startTurn(text, failure) {
    const controller = new AbortController();
    const turn = { controller };
    active = turn;
    const user = { role: 'user', content: text, timestamp: Date.now() };
    append(user);
    output({ type: 'agent_start' });
    output({ type: 'message_end', message: user });
    turn.promise = (async () => {
      let assistant, aborted = false;
      try {
        output({ type: 'message_start', message: { role: 'assistant', content: [], stopReason: 'pending' } });
        if (failure) {
          await delay(chunkMs, undefined, { signal: controller.signal });
          assistant = { role: 'assistant', provider: 'openai-codex', model: 'dummy-lorem', stopReason: 'error', errorMessage: failure, content: [{ type: 'text', text: `[dummy] ${failure}` }], timestamp: Date.now() };
        } else {
          output({ type: 'tool_execution_start', toolCallId: `dummy-${leaf}`, toolName: 'dummy_noop', args: {} });
          output({ type: 'tool_execution_end', toolCallId: `dummy-${leaf}`, toolName: 'dummy_noop', result: { content: [{ type: 'text', text: '[dummy] No tool was executed.' }] }, isError: false });
          for (const delta of DUMMY_TEXT.match(/.{1,24}/g)) {
            await delay(chunkMs, undefined, { signal: controller.signal });
            output({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta } });
          }
          assistant = { role: 'assistant', provider: 'openai-codex', model: 'dummy-lorem', stopReason: 'stop', content: [{ type: 'text', text: DUMMY_TEXT }], timestamp: Date.now() };
        }
        append(assistant); output({ type: 'message_end', message: assistant });
      } catch (error) {
        if (!controller.signal.aborted) throw error;
        aborted = true;
      } finally {
        if (active === turn) active = undefined;
        output({ type: 'agent_end', messages: [], willRetry: false });
        output({ type: 'agent_settled', aborted });
      }
      if (!aborted && isCodexQuotaError(assistant) && autoResume && !closed) wait();
    })();
    // Transport owners must close on output failure, never leave a rejected task.
    void turn.promise.catch(() => { void close(); });
  }
  async function close() {
    return closing ||= (async () => {
      closed = true; cancel();
      const turn = active;
      turn?.controller.abort();
      await turn?.promise.catch(() => {});
      await service.close();
    })();
  }
  async function command(record) {
    if (closed) return;
    const response = (success, data, error) => output({ type: 'response', ...(typeof record?.id === 'string' ? { id: record.id } : {}), command: typeof record?.type === 'string' ? record.type : 'parse', success, ...(data ? { data } : {}), ...(error ? { error } : {}) });
    if (!object(record) || (record.id !== undefined && (typeof record.id !== 'string' || record.id.length > 256))) { response(false, undefined, 'Invalid dummy command.'); return; }
    const fields = record.type === 'prompt' ? ['type', 'id', 'message'] : ['type', 'id'];
    if (Object.keys(record).some(key => !fields.includes(key))) { response(false, undefined, 'Unsupported dummy command fields.'); return; }
    if (record.type === 'get_state') {
      response(true, { sessionId, sessionName: 'Offline dummy (no tokens)', model: { id: 'dummy-lorem', name: 'Offline dummy', provider: 'openai-codex' }, isStreaming: Boolean(active), isCompacting: false, pendingMessageCount: 0, messageCount: messages.length, dummy: true, autoResume, resumes }); return;
    }
    if (record.type === 'get_messages') { response(true, { messages }); return; }
    if (record.type === 'clear_queue') { response(true, { steering: [], followUp: [] }); return; }
    if (record.type === 'abort') {
      cancel();
      const turn = active; turn?.controller.abort(); await turn?.promise.catch(() => {});
      response(true); return;
    }
    if (record.type !== 'prompt' || typeof record.message !== 'string' || !record.message.trim() || Buffer.byteLength(record.message) > 64 * 1024) { response(false, undefined, 'Unsupported dummy command or prompt.'); return; }
    const text = record.message.trim();
    // Simulator controls do not append a conversation message/change the leaf.
    // Refill is intentionally out-of-band, like quota changing at the provider.
    if (text === '/dummy refill') { exhaustedUntil = 0; status('available'); response(true, { disposition: 'handled' }); return; }
    if (text === '/dummy status') { status(Date.now() < exhaustedUntil ? 'exhausted' : 'available'); response(true, { disposition: 'handled' }); return; }
    if (text === '/dummy cancel' || text === '/dummy auto off') { if (text.endsWith('off')) autoResume = false; cancel(); response(true, { disposition: 'handled' }); return; }
    if (text === '/dummy auto on') { autoResume = true; response(true, { disposition: 'handled' }); return; }
    if (active) { response(false, undefined, 'Dummy agent is busy; messages are not queued.'); return; }
    cancel();
    let failure;
    const quota = /^\/dummy quota (hold|[1-9]\d{0,2})$/.exec(text);
    if (quota) {
      if (quota[1] !== 'hold' && Number(quota[1]) > 300) { response(false, undefined, 'Dummy quota duration must be 1–300 seconds or hold.'); return; }
      exhaustedUntil = quota[1] === 'hold' ? Infinity : Date.now() + Number(quota[1]) * 1000;
    } else if (text === '/dummy transient') {
      exhaustedUntil = 0; failure = '429 transient rate limit (dummy usage is available).';
    } else if (text === '/dummy error') failure = 'Simulated non-quota network failure.';
    else if (text.startsWith('/dummy')) { response(false, undefined, 'Unknown dummy control.'); return; }
    if (!failure && Date.now() < exhaustedUntil) failure = '429 usage_limit_reached: simulated Codex quota exhausted.';
    response(true, { disposition: 'started' });
    startTurn(record.message, failure);
  }
  return { command, close };
}
