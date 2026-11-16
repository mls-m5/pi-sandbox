// Agent key input is never echoed, printed or accepted in argv/environment.
export async function readAgentKey({
  piped = false,
  input = process.stdin,
  output = process.stderr,
} = {}) {
  const validate = (value) => {
    if (value.length !== 43 || !/^[A-Za-z0-9_-]{43}$/.test(value))
      throw new Error('Expected one 43-character agent key.');
    return value;
  };
  if (piped) {
    let value = '';
    for await (const chunk of input) {
      value += chunk;
      if (Buffer.byteLength(value) > 46) throw new Error('Agent key input too large.');
    }
    return validate(value.replace(/\r?\n$/, ''));
  }
  if (!input.isTTY || !output.isTTY || !input.setRawMode)
    throw new Error('Agent registration needs a terminal or explicit --key-stdin.');
  output.write('Agentnyckel från webbpanelen (dold): ');
  return new Promise((resolve, reject) => {
    let value = '',
      finished = false;
    const wasRaw = input.isRaw;
    const finish = (error) => {
      if (finished) return;
      finished = true;
      input.off('data', onData);
      input.off('end', cancelled);
      input.off('error', cancelled);
      for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.off(signal, cancelled);
      input.setRawMode(Boolean(wasRaw));
      input.pause();
      output.write('\n');
      if (error) reject(error);
      else {
        try {
          resolve(validate(value));
        } catch (error) {
          reject(error);
        }
      }
    };
    const cancelled = () => finish(new Error('Agent registration cancelled.'));
    const onData = (chunk) => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\x03' || char === '\x04') {
          cancelled();
          return;
        }
        if (char === '\r' || char === '\n') {
          finish();
          return;
        }
        if (char === '\x7f' || char === '\b') value = value.slice(0, -1);
        else value += char;
        if (value.length > 43) {
          finish(new Error('Agent key input too large.'));
          return;
        }
      }
    };
    input.setRawMode(true);
    input.on('data', onData);
    input.once('end', cancelled);
    input.once('error', cancelled);
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, cancelled);
    input.resume();
  });
}
