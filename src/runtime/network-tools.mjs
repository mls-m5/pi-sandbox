// Trusted image-owned Pi extension: message tools for agents in the same pis network.
import { Type } from 'typebox';
import { NETWORK_TOOLS, runNetworkTool, startPushLoop } from './network-client.mjs';

const SCHEMAS = {
  send_message: Type.Object({
    to: Type.String({ description: 'Project name or id from list_peers' }),
    text: Type.String({ description: 'The message (max 4096 bytes). Be brief and concrete.' }),
    reply_to: Type.Optional(
      Type.String({ description: 'Optional project name/id that should receive the reply.' }),
    ),
  }),
  receive_messages: Type.Object({
    wait_seconds: Type.Optional(Type.Integer({ minimum: 0, maximum: 60 })),
  }),
  list_peers: Type.Object({}),
};

export default function (pi) {
  const socketPath = process.env.PIS_NET_SOCKET;
  if (!socketPath) return;
  // The host enables live delivery for terminal Pi on a configured network unless opted out.
  // An idle session can start a model turn; a working session receives native steering.
  let waiting = 0;
  if (process.env.PIS_NET_PUSH === '1') {
    let loop;
    pi.on('session_start', () => {
      loop?.stop();
      loop = startPushLoop({
        socketPath,
        isWaiting: () => waiting > 0,
        deliver: async (text) => {
          try {
            await pi.sendMessage(
              { customType: 'pis-network', content: text, display: true },
              { triggerTurn: true, deliverAs: 'steer' },
            );
          } catch {
            // The message stays in the host archive; never crash the session.
          }
        },
      });
    });
    pi.on('session_shutdown', () => {
      loop?.stop();
      loop = undefined;
    });
  }
  for (const tool of NETWORK_TOOLS)
    pi.registerTool({
      name: tool.name,
      label: tool.name.replace(/_/g, ' '),
      exposure: 'model-only',
      description: tool.description,
      parameters: SCHEMAS[tool.name],
      async execute(_id, params) {
        // While the agent itself waits for messages, the push loop stays out of the way.
        if (tool.name === 'receive_messages') waiting++;
        let result;
        try {
          result = await runNetworkTool(tool.name, params, socketPath);
        } finally {
          if (tool.name === 'receive_messages') waiting--;
        }
        if (result.isError) throw new Error(result.text);
        return { content: [{ type: 'text', text: result.text }], details: undefined };
      },
    });
}
