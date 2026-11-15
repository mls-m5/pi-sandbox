const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// Strict ordinary-record framing; LF only (not Unicode line separators).
export class JsonlDecoder {
  constructor(onRecord, onFault, maxBytes = 4 * 1024 * 1024) {
    this.onRecord = onRecord; this.onFault = onFault; this.maxBytes = maxBytes;
    this.buffer = null; this.bytes = 0; this.failed = false;
  }
  push(chunk) {
    if (this.failed) return;
    let start = 0;
    while (start < chunk.length) {
      const lf = chunk.indexOf(10, start), end = lf < 0 ? chunk.length : lf, part = chunk.subarray(start, end);
      if (this.bytes + part.length > this.maxBytes) return this.fail('rpc_record_too_large');
      this.buffer ??= Buffer.allocUnsafe(this.maxBytes);
      part.copy(this.buffer, this.bytes); this.bytes += part.length;
      if (lf < 0) return;
      let line = this.buffer.subarray(0, this.bytes); this.bytes = 0;
      if (line.at(-1) === 13) line = line.subarray(0, -1);
      try {
        const record = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line));
        if (!object(record) || typeof record.type !== 'string') throw new Error('Invalid record.');
        this.onRecord(record);
      } catch { return this.fail('rpc_invalid_record'); }
      start = lf + 1;
    }
  }
  end() { if (!this.failed && this.bytes) this.fail('rpc_incomplete_record'); }
  fail(code) { this.failed = true; this.buffer = null; this.bytes = 0; this.onFault(code); }
}
