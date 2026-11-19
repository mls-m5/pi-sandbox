// Image-owned Claude Code hook (PostToolUse, UserPromptSubmit, Stop). It only READS the host-owned
// message socket (sender identity is fixed by the host) and hands queued messages to Claude as
// untrusted context. It never approves anything and is silent when there is nothing to deliver.
import net from 'node:net';

function receive(socketPath) {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    let response = '';
    socket.setTimeout(3000, () => socket.destroy());
    socket.on('connect', () => socket.end(`${JSON.stringify({ op: 'receive' })}\n`));
    socket.on('data', (chunk) => {
      response += chunk.toString('utf8');
      if (response.length > 65536) socket.destroy();
    });
    socket.on('end', () => {
      try {
        resolve(JSON.parse(response));
      } catch {
        resolve(undefined);
      }
    });
    socket.on('error', () => resolve(undefined));
    socket.on('close', () => resolve(undefined));
  });
}

/** Pure mapping used by tests: hook event + received text -> hook JSON (or undefined). */
export function hookOutput(event, text) {
  if (event === 'Stop')
    // Keeps Claude working on the messages instead of going idle. Each message is delivered
    // once and the host rate limits senders, so this cannot loop without new messages.
    return { decision: 'block', reason: text };
  if (event === 'PostToolUse' || event === 'UserPromptSubmit')
    return { hookSpecificOutput: { hookEventName: event, additionalContext: text } };
  return undefined;
}

async function main() {
  const socketPath = process.env.PIS_NET_SOCKET;
  if (!socketPath) return;
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 1_000_000) return;
  }
  let event;
  try {
    event = JSON.parse(input).hook_event_name;
  } catch {
    return;
  }
  const result = await receive(socketPath);
  if (!result?.ok || !(result.count > 0)) return;
  const output = hookOutput(event, result.text);
  if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().then(() => process.exit(0));
