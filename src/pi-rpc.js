import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const failure = code => Object.assign(new Error(code), { code });

// Byte framing avoids splitting Unicode separators or decoding partial UTF-8 characters.
export class JsonlDecoder {
  constructor(onRecord, onFault, maxBytes = 4 * 1024 * 1024) {
    this.onRecord = onRecord;
    this.onFault = onFault;
    this.maxBytes = maxBytes;
    this.buffer = null;
    this.bytes = 0;
    this.failed = false;
  }

  push(chunk) {
    if (this.failed) return; // The stream owner keeps draining even after a fault.
    let start = 0;
    while (start < chunk.length) {
      const lf = chunk.indexOf(10, start);
      const end = lf < 0 ? chunk.length : lf;
      const part = chunk.subarray(start, end);
      if (this.bytes + part.length > this.maxBytes) return this.fail('rpc_record_too_large');
      this.buffer ??= Buffer.allocUnsafe(this.maxBytes);
      part.copy(this.buffer, this.bytes);
      this.bytes += part.length;
      if (lf < 0) return;
      let line = this.buffer.subarray(0, this.bytes);
      this.bytes = 0;
      if (line.at(-1) === 13) line = line.subarray(0, -1);
      try {
        const record = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line));
        if (!object(record) || typeof record.type !== 'string') throw failure('invalid');
        this.onRecord(record);
      } catch {
        return this.fail('rpc_invalid_record');
      }
      start = lf + 1;
    }
  }

  end() {
    if (!this.failed && this.bytes) this.fail('rpc_incomplete_record');
  }

  fail(code) {
    this.failed = true;
    this.buffer = null;
    this.bytes = 0;
    this.onFault(code);
  }
}

// This is an internal local-pipe API, NOT an authenticated network endpoint.
// The caller owns spawning, project locks, signals and final process cleanup.
export class PiRpc extends EventEmitter {
  constructor(child, { maxRecordBytes, maxPending = 16, maxWriteBytes = 256 * 1024, timeoutMs = 30_000 } = {}) {
    super();
    this.child = child;
    this.maxPending = maxPending;
    this.maxWriteBytes = maxWriteBytes;
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
    this.queue = [];
    this.writeBytes = 0;
    this.writing = false;
    this.status = 'unknown';
    this.revision = 0;
    this.closed = false;
    this.faulted = false;
    this.stopping = false;
    this.decoder = new JsonlDecoder(record => this.record(record), code => this.fault(code), maxRecordBytes);
    child.stdout.on('data', chunk => this.decoder.push(chunk));
    child.stdout.on('end', () => { this.decoder.end(); if (!this.stopping) this.fault('rpc_stdout_closed'); });
    child.stdout.on('error', () => this.fault('rpc_stdout_error'));
    // Diagnostics may contain secrets. Drain, but do not retain/forward them.
    child.stderr?.resume();
    child.stderr?.on('error', () => {});
    child.stdin.on('error', () => this.fault('rpc_stdin_error'));
    child.on('error', () => this.finish('rpc_process_error'));
    child.on('close', () => this.finish('rpc_process_closed'));
  }

  setStatus(status) {
    this.revision++;
    if (status !== this.status) { this.status = status; this.emit('status', status); }
  }

  fault(code) {
    if (this.closed || this.faulted) return;
    this.faulted = true;
    this.setStatus('unknown');
    this.rejectPending(code);
    this.emit('fault', code); // Never include raw protocol/diagnostic contents.
  }

  rejectPending(code) {
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(failure(code)); }
    this.pending.clear();
    this.queue = [];
    this.writeBytes = 0;
  }

  finish(code) {
    if (this.closed) return;
    this.closed = true;
    this.rejectPending(code);
    this.setStatus('offline');
    this.emit('closed', code);
  }

  record(record) {
    if (this.closed || this.faulted) return;
    if (record.type === 'response') {
      const entry = this.pending.get(record.id);
      if (!entry) return; // Late/unsolicited response must never resolve another command.
      if (record.command !== entry.type || typeof record.success !== 'boolean') return this.fault('rpc_response_mismatch');
      this.pending.delete(record.id);
      clearTimeout(entry.timer);
      if (entry.type === 'get_state' && record.success && this.revision === entry.revision) {
        const state = record.data;
        if (object(state) && typeof state.isStreaming === 'boolean' && typeof state.isCompacting === 'boolean' && Number.isInteger(state.pendingMessageCount)) {
          this.setStatus(state.isStreaming || state.isCompacting || state.pendingMessageCount > 0 ? 'working' : 'idle');
        }
      }
      entry.resolve(record);
      return;
    }
    if (record.type === 'agent_start' || record.type === 'compaction_start' || record.type === 'auto_retry_start') this.setStatus('working');
    if (record.type === 'agent_settled') this.setStatus('idle');
    // agent_end is deliberately NOT interpreted as idle.
    if (record.type === 'extension_ui_request' && ['select', 'confirm', 'input', 'editor'].includes(record.method)) {
      if (typeof record.id !== 'string' || record.id.length > 256) return this.fault('rpc_invalid_dialog');
      try { this.enqueue({ type: 'extension_ui_response', id: record.id, cancelled: true }); }
      catch { return this.fault('rpc_dialog_cancel_failed'); }
      this.emit('dialog_cancelled', { method: record.method });
      return;
    }
    this.emit('event', record); // Untrusted local records; no network-safe projection implied.
  }

  enqueue(record) {
    if (this.closed || this.faulted || this.stopping) throw failure('rpc_unavailable');
    const line = Buffer.from(`${JSON.stringify(record)}\n`);
    if (this.writeBytes + line.length > this.maxWriteBytes) throw failure('rpc_write_limit');
    this.writeBytes += line.length;
    this.queue.push(line);
    this.pump();
    return line;
  }

  pump() {
    if (this.writing || !this.queue.length || this.closed || this.faulted) return;
    this.writing = true;
    const line = this.queue.shift();
    // Only one write in flight; its callback waits for the Writable to consume it.
    this.child.stdin.write(line, error => {
      this.writing = false;
      this.writeBytes = Math.max(0, this.writeBytes - line.length);
      if (error) this.fault('rpc_write_failed');
      else this.pump();
    });
  }

  request(type, fields = {}) {
    if (!['get_state', 'get_messages', 'prompt', 'clear_queue', 'abort'].includes(type)) return Promise.reject(failure('rpc_command_forbidden'));
    if (this.closed || this.faulted || this.stopping) return Promise.reject(failure('rpc_unavailable'));
    if (this.pending.size >= this.maxPending) return Promise.reject(failure('rpc_pending_limit'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      let line;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const index = this.queue.indexOf(line);
        if (index >= 0) {
          this.queue.splice(index, 1);
          this.writeBytes -= line.length;
        }
        this.setStatus('unknown');
        reject(failure('rpc_timeout_ambiguous')); // Never retry an ambiguous mutation.
      }, this.timeoutMs);
      this.pending.set(id, { type, resolve, reject, timer, revision: this.revision });
      try { line = this.enqueue({ ...fields, type, id }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  // Explicit local lifecycle operation, never called for a network disconnect.
  async shutdown({ graceMs = 5000, killMs = 2000 } = {}) {
    if (this.closed) return;
    this.stopping = true;
    this.rejectPending('rpc_shutting_down');
    const done = new Promise(resolve => this.once('closed', resolve));
    this.child.stdin.end();
    const terminate = setTimeout(() => this.child.kill('SIGTERM'), graceMs);
    const kill = setTimeout(() => this.child.kill('SIGKILL'), graceMs + killMs);
    let deadline;
    try {
      await Promise.race([done, new Promise((_, reject) => {
        deadline = setTimeout(() => reject(failure('rpc_shutdown_unconfirmed')), graceMs + killMs + 1000);
      })]);
    } finally { clearTimeout(terminate); clearTimeout(kill); clearTimeout(deadline); }
  }
}

export function validateControlCommand(value) {
  if (!object(value) || value.v !== 1 || typeof value.generation !== 'string' || value.generation.length > 64 ||
      typeof value.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value.id) ||
      !['state', 'history', 'prompt', 'stop'].includes(value.action)) throw failure('control_invalid_command');
  const keys = ['v', 'generation', 'id', 'action', ...(value.action === 'prompt' ? ['message'] : [])];
  if (Object.keys(value).some(key => !keys.includes(key))) throw failure('control_invalid_command');
  if (value.action === 'prompt' && (typeof value.message !== 'string' || !value.message.trim() || Buffer.byteLength(value.message) > 64 * 1024)) throw failure('control_invalid_prompt');
  return { v: 1, generation: value.generation, id: value.id, action: value.action, ...(value.action === 'prompt' ? { message: value.message } : {}) };
}

// Deduplication survives network reconnects for this runtime, without retaining transcripts.
// IDs are never evicted: fail closed on exhaustion rather than replay an old mutation.
export class PiControl {
  constructor(rpc, { maxCommands = 4096 } = {}) {
    this.rpc = rpc;
    this.generation = randomUUID();
    this.maxCommands = maxCommands;
    this.seen = new Map();
    this.mutating = false;
  }

  async execute(input) {
    const command = validateControlCommand(input);
    if (command.generation !== this.generation) throw failure('control_stale_generation');
    const hash = createHash('sha256').update(JSON.stringify(command)).digest('hex');
    if (this.seen.has(command.id)) {
      if (this.seen.get(command.id) !== hash) throw failure('control_id_conflict');
      return { duplicate: true }; // Original outcome may be unknown; resynchronize, never replay.
    }
    if (this.seen.size >= this.maxCommands) throw failure('control_id_limit');
    this.seen.set(command.id, hash);
    if (command.action === 'state') return this.rpc.request('get_state');
    if (command.action === 'history') return this.rpc.request('get_messages');
    if (this.mutating) throw failure('control_mutation_pending');
    if (command.action === 'prompt' && this.rpc.status !== 'idle') throw failure('control_not_idle');
    this.mutating = true;
    try {
      if (command.action === 'stop') {
        const cleared = await this.rpc.request('clear_queue');
        if (!cleared.success) return cleared;
        return await this.rpc.request('abort');
      }
      this.rpc.setStatus('working'); // Reserve before awaiting acceptance, preventing double submit.
      const result = await this.rpc.request('prompt', { message: command.message });
      // Acceptance is not completion. A handled prompt may have started independent extension work.
      if (!result.success || result.data?.disposition === 'handled') this.rpc.setStatus('unknown');
      return result;
    } catch (error) {
      if (!this.rpc.closed && !this.rpc.faulted) this.rpc.setStatus('unknown');
      throw error;
    } finally { this.mutating = false; }
  }
}
