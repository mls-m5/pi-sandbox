import { JsonlDecoder } from './jsonl.js';

export const HISTORY_LIMITS = Object.freeze({ headerBytes: 2048, suffixBytes: 2048, retainedBytes: 1024 * 1024, messages: 100, recordBytes: 128 * 1024 * 1024, depth: 128 });
const whitespace = byte => byte === 32 || byte === 9 || byte === 13;
const decode = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
const parse = bytes => JSON.parse(decode(bytes));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const omittedBody = Buffer.from(JSON.stringify({ role: 'custom', display: true, content: '[pis web] Message body omitted from the bounded history view; saved session is unchanged.' }));

// Only the documented native response prefix is specialized, and only for a
// currently correlated read-only get_messages request. All other records retain
// strict ordinary JSONL limits. No RPC command/tool/session data is replayed.
function historyHeader(bytes, isHistoryRequest) {
  try {
    const header = parse(Buffer.concat([bytes, Buffer.from(']}}')]));
    if (!object(header) || Object.keys(header).length !== 5 || header.type !== 'response' || header.command !== 'get_messages' || header.success !== true || typeof header.id !== 'string' ||
        !object(header.data) || Object.keys(header.data).length !== 1 || !Array.isArray(header.data.messages) || header.data.messages.length || !isHistoryRequest(header.id)) return;
    return header;
  } catch { return; }
}

class HistoryTail {
  constructor(header, prefix, limits, messageBytes) {
    this.header = header; this.prefix = Buffer.from(prefix); this.limits = limits; this.messageBytes = messageBytes;
    this.recordBytes = prefix.length; this.state = 'first'; this.queue = []; this.retainedBytes = 0; this.total = 0;
    this.buffer = null; this.bytes = 0; this.stack = []; this.quoted = false; this.escaped = false;
    this.suffix = Buffer.allocUnsafe(limits.suffixBytes); this.suffixLength = 0; this.limited = false;
  }
  limit() {
    this.limited = true; this.buffer = null; this.queue = []; this.retainedBytes = 0;
  }
  finishMessage() {
    const bytes = this.buffer.subarray(0, this.bytes);
    parse(bytes); // Validate every retained/omitted bounded value, not just braces.
    this.total++;
    const bodyOmitted = bytes.length > this.limits.retainedBytes;
    const retained = bodyOmitted ? omittedBody : Buffer.from(bytes);
    this.queue.push({ bytes: retained, bodyOmitted }); this.retainedBytes += retained.length;
    while (this.queue.length > this.limits.messages || this.retainedBytes > this.limits.retainedBytes) this.retainedBytes -= this.queue.shift().bytes.length;
    this.bytes = 0;
  }
  push(part) {
    if (this.limited) return;
    this.recordBytes += part.length;
    if (this.recordBytes > this.limits.recordBytes) { this.limit(); return; }
    for (const byte of part) {
      if (this.state === 'suffix') {
        if (this.suffixLength >= this.limits.suffixBytes) { this.limit(); return; }
        this.suffix[this.suffixLength++] = byte; continue;
      }
      if (this.state === 'first' || this.state === 'next') {
        if (whitespace(byte)) continue;
        if (byte === 93) {
          if (this.state === 'next') throw new Error('Trailing comma.');
          this.state = 'suffix'; continue;
        }
        if (byte === 44) throw new Error('Empty message.');
        this.state = 'value'; this.stack = []; this.quoted = false; this.escaped = false;
      } else if (!this.quoted && this.stack.length === 0 && (byte === 44 || byte === 93)) {
        this.finishMessage(); this.state = byte === 44 ? 'next' : 'suffix'; continue;
      }
      if (this.bytes >= this.messageBytes) { this.limit(); return; }
      this.buffer ??= Buffer.allocUnsafe(this.messageBytes);
      this.buffer[this.bytes++] = byte;
      if (this.quoted) {
        if (byte < 32) throw new Error('Invalid string control.');
        if (this.escaped) this.escaped = false;
        else if (byte === 92) this.escaped = true;
        else if (byte === 34) this.quoted = false;
      } else if (byte === 34) this.quoted = true;
      else if (byte === 123 || byte === 91) {
        this.stack.push(byte);
        if (this.stack.length > this.limits.depth) { this.limit(); return; }
      } else if (byte === 125 || byte === 93) {
        if (this.stack.pop() !== (byte === 125 ? 123 : 91)) throw new Error('Mismatched JSON container.');
      }
    }
  }
  finish() {
    if (this.limited) return null; // Discarded to LF: do not claim a valid snapshot.
    if (this.state !== 'suffix') throw new Error('Incomplete history.');
    const end = parse(Buffer.concat([this.prefix, Buffer.from(']'), this.suffix.subarray(0, this.suffixLength)]));
    if (Object.keys(end).length !== 5 || !object(end.data) || Object.keys(end.data).length !== 1 || end.id !== this.header.id || end.command !== 'get_messages' || end.type !== 'response' || end.success !== true || !Array.isArray(end.data?.messages) || end.data.messages.length) throw new Error('History envelope changed.');
    const messages = this.queue.map(entry => parse(entry.bytes));
    const omittedMessages = this.total - messages.length;
    const omittedMessageBodies = this.queue.filter(entry => entry.bodyOmitted).length;
    const truncated = omittedMessages > 0 || omittedMessageBodies > 0;
    return { id: this.header.id, type: 'response', command: 'get_messages', success: true, data: { messages,
      ...(truncated ? { historyWindow: { totalMessages: this.total, omittedMessages, omittedMessageBodies, truncated: true } } : {}) } };
  }
}

export class RpcHistoryDecoder {
  constructor({ onRecord, onFault, onHistoryLimit, isHistoryRequest, maxRecordBytes = 4 * 1024 * 1024, limits = {} }) {
    this.onRecord = onRecord; this.onFault = onFault; this.onHistoryLimit = onHistoryLimit; this.isHistoryRequest = isHistoryRequest;
    this.limits = { ...HISTORY_LIMITS, ...limits };
    for (const [key, value] of Object.entries(this.limits)) if (!Number.isSafeInteger(value) || value < 1 || value > HISTORY_LIMITS[key]) throw new Error('Invalid bounded history limit.');
    this.maxRecordBytes = maxRecordBytes;
    this.prefix = Buffer.allocUnsafe(Math.min(this.limits.headerBytes, maxRecordBytes));
    this.normal = new JsonlDecoder(onRecord, code => this.fail(code), maxRecordBytes);
    this.failed = false; this.reset();
  }
  reset() { this.mode = 'prefix'; this.prefixLength = 0; this.quoted = false; this.escaped = false; this.history = null; this.hasBytes = false; }
  fail(code) { if (!this.failed) { this.failed = true; this.history = null; this.onFault(code); } }
  part(bytes) {
    if (bytes.length) this.hasBytes = true;
    if (this.mode === 'normal') { this.normal.push(bytes); return; }
    if (this.mode === 'history') { this.history.push(bytes); return; }
    for (let index = 0; index < bytes.length; index++) {
      const byte = bytes[index]; this.prefix[this.prefixLength++] = byte;
      const arrayStart = byte === 91 && !this.quoted;
      if (this.quoted) {
        if (this.escaped) this.escaped = false;
        else if (byte === 92) this.escaped = true;
        else if (byte === 34) this.quoted = false;
      } else if (byte === 34) this.quoted = true;
      if (arrayStart || this.prefixLength === this.prefix.length) {
        const prefix = this.prefix.subarray(0, this.prefixLength);
        const header = arrayStart ? historyHeader(prefix, this.isHistoryRequest) : undefined;
        if (header) { this.mode = 'history'; this.history = new HistoryTail(header, prefix, this.limits, this.maxRecordBytes); }
        else { this.mode = 'normal'; this.normal.push(prefix); }
        this.part(bytes.subarray(index + 1)); return;
      }
    }
  }
  push(chunk) {
    if (this.failed) return; // Owner keeps consuming stdout even after a fault.
    let start = 0;
    while (start < chunk.length && !this.failed) {
      const lf = chunk.indexOf(10, start), end = lf < 0 ? chunk.length : lf;
      try {
        this.part(chunk.subarray(start, end));
        if (lf < 0 || this.failed) return;
        if (this.mode === 'history') {
          const record = this.history.finish();
          if (record) this.onRecord(record);
          else this.onHistoryLimit(this.history.header.id, 'rpc_history_limit');
        } else {
          if (this.mode === 'prefix') this.normal.push(this.prefix.subarray(0, this.prefixLength));
          this.normal.push(Buffer.from('\n'));
        }
        this.reset();
      } catch { this.fail('rpc_invalid_record'); return; }
      start = lf + 1;
    }
  }
  end() { if (!this.failed && this.hasBytes) this.fail('rpc_incomplete_record'); }
}
