import { readPipedLine, readTerminalLine } from '../src/terminal-input.js';

// Caller policies stay separate: admin empty input requests generation later;
// agent keys must be exactly one existing 43-character capability.
export async function readAgentKey({
  piped = false,
  input = process.stdin,
  output = process.stderr,
} = {}) {
  const options = { input, limitError: 'Agent key input too large.' };
  const value = piped
    ? await readPipedLine({
        ...options,
        maxBytes: 46,
        lineError: 'Expected one 43-character agent key.',
      })
    : await readTerminalLine({
        ...options,
        output,
        prompt: 'Agentnyckel från webbpanelen (dold): ',
        maxBytes: 43,
        acceptCharacter: () => true,
        ttyError: 'Agent registration needs a terminal or explicit --key-stdin.',
        cancelError: 'Agent registration cancelled.',
      });
  if (value.length !== 43 || !/^[A-Za-z0-9_-]{43}$/.test(value))
    throw new Error('Expected one 43-character agent key.');
  return value;
}

export function readAdminPassword({
  piped = false,
  input = process.stdin,
  output = process.stderr,
} = {}) {
  const options = { input, limitError: 'Password input too large.' };
  return piped
    ? readPipedLine({ ...options, maxBytes: 1026, lineError: 'Provide one password line.' })
    : readTerminalLine({
        ...options,
        output,
        maxBytes: 1024,
        prompt:
          'Adminlösenord (minst 20 tecken, dolt; Enter genererar och visar ett tillfälligt lösenord): ',
        ttyError: 'Use a terminal or explicit --password-stdin.',
        closedError: 'Password input closed.',
        cancelError: 'Cancelled.',
      });
}
