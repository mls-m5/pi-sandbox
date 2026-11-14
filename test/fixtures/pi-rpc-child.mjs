// Offline subprocess: no Pi package, credentials, network or model requests.
import { JsonlDecoder } from '../../src/pi-rpc.js';
const send = record => process.stdout.write(`${JSON.stringify(record)}\n`);
const decoder = new JsonlDecoder(command => {
  if (command.type === 'get_state') send({ id: command.id, type: 'response', command: command.type, success: true, data: { isStreaming: false, isCompacting: false, pendingMessageCount: 0 } });
  else if (command.type === 'get_messages') send({ id: command.id, type: 'response', command: command.type, success: true, data: { messages: [] } });
  else if (command.type === 'prompt') {
    send({ type: 'agent_start' });
    send({ id: command.id, type: 'response', command: command.type, success: true, data: { disposition: 'started' } });
    setTimeout(() => {
      send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Hej åäö\u2028värld' } });
      send({ type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'fake', args: {} });
      send({ type: 'tool_execution_end', toolCallId: 'tool-1', toolName: 'fake', result: { content: [] }, isError: false });
      send({ type: 'agent_end', messages: [] });
      send({ type: 'agent_settled', aborted: false });
    }, 20);
  } else send({ id: command.id, type: 'response', command: command.type, success: true });
}, () => process.exit(2));
process.stdin.on('data', chunk => decoder.push(chunk));
process.stdin.on('end', () => { decoder.end(); });
