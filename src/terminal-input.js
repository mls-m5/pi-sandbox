import { StringDecoder } from 'node:string_decoder';

// Shared editing/lifecycle only. Credential formats, defaults, file writes and
// whether empty input generates a secret remain the caller's responsibility.
export function readTerminalLine({
  input = process.stdin,
  output = process.stderr,
  prompt,
  hidden = true,
  defaultValue = '',
  maxBytes = 65536,
  acceptCharacter = (char) => char >= ' ' && char !== '\x7f',
  ttyError = 'An interactive terminal is required.',
  limitError = 'Input too large.',
  cancelError = 'Input cancelled.',
  closedError = cancelError,
} = {}) {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function')
    return Promise.reject(new Error(ttyError));
  return new Promise((resolve, reject) => {
    let value = '',
      settled = false;
    const wasRaw = Boolean(input.isRaw),
      decoder = new StringDecoder('utf8');
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    const finish = (error) => {
      if (settled) return;
      settled = true;
      input.off('data', onData);
      input.off('end', onEnd);
      input.off('error', onEnd);
      for (const signal of signals) process.off(signal, onCancel);
      try {
        input.setRawMode(wasRaw);
        input.pause();
        output.write('\n');
      } catch {
        error ||= new Error(cancelError);
      }
      if (error) reject(error);
      else resolve(value || defaultValue);
    };
    const onEnd = () => finish(new Error(closedError));
    const onCancel = () => finish(new Error(cancelError));
    const onData = (chunk) => {
      const text = typeof chunk === 'string' ? chunk : decoder.write(chunk);
      for (const char of text) {
        if (char === '\x03' || char === '\x04') {
          onCancel();
          return;
        }
        if (char === '\r' || char === '\n') {
          finish();
          return;
        }
        if (char === '\x7f' || char === '\b') {
          if (value) {
            value = Array.from(value).slice(0, -1).join('');
            if (!hidden) output.write('\b \b');
          }
        } else if (acceptCharacter(char)) {
          value += char;
          if (Buffer.byteLength(value) > maxBytes) {
            finish(new Error(limitError));
            return;
          }
          if (!hidden) output.write(char);
        }
      }
    };
    try {
      output.write(prompt);
      input.on('data', onData);
      input.once('end', onEnd);
      input.once('error', onEnd);
      for (const signal of signals) process.once(signal, onCancel);
      input.setRawMode(true);
      input.resume();
    } catch {
      finish(new Error(cancelError));
    }
  });
}

export async function readPipedLine({ input = process.stdin, maxBytes, limitError, lineError }) {
  let value = '',
    bytes = 0;
  const decoder = new StringDecoder('utf8');
  for await (const chunk of input) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > maxBytes) throw new Error(limitError);
    value += typeof chunk === 'string' ? chunk : decoder.write(chunk);
  }
  value += decoder.end();
  value = value.replace(/\r?\n$/, '');
  if (/[\r\n]/.test(value)) throw new Error(lineError);
  return value;
}
