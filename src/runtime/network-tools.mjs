// Trusted image-owned Pi extension: message tools for agents in the same pis network.
import { Type } from 'typebox';
import { NETWORK_TOOLS, runNetworkTool } from './network-client.mjs';

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
  for (const tool of NETWORK_TOOLS)
    pi.registerTool({
      name: tool.name,
      label: tool.name.replace(/_/g, ' '),
      exposure: 'model-only',
      description: tool.description,
      parameters: SCHEMAS[tool.name],
      async execute(_id, params) {
        const result = await runNetworkTool(tool.name, params, socketPath);
        if (result.isError) throw new Error(result.text);
        return { content: [{ type: 'text', text: result.text }], details: undefined };
      },
    });
}
