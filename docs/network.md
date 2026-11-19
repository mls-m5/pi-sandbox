# Agent message network (experimental, step 1)

Running agents in **different registered projects** can exchange short messages through the host. This is not `pi-subagents` (children inside one agent) and it never starts, stops or controls another agent.

## Setup

Give each project the same network name in `pis --edit`:

```json
{ "network": "team-a" }
```

`pis --list` shows the network as a fourth tab-separated column (`-` when none). Names are lowercase letters, digits and dashes (max 32). Without the field nothing changes. Projects with the same name are peers; addresses are project names (or IDs). `pis --new --from OLD` copies the field.

## Tools

Offered to Pi (extension `network-tools.mjs`) and Claude Code (MCP server `pis-host`, tools `mcp__pis-host__…`) whenever the launch runs an agent task, including print mode, but not `--bash`/`--exec`/management/`--help` runs or web RPC:

- `send_message(to, text, reply_to?)` — one short message; `reply_to` names who should get the answer (default: sender).
- `receive_messages(wait_seconds?)` — up to 10 queued messages, oldest first; may wait up to 60 s.
- `list_peers()` — shows **your own** registered project name and ID first, then other projects on the same network. It also shows the folder basename as a hint, never the full host path. Address messages by registered name or project ID, not the folder hint. You can set a project name with `pis --edit`.

Tool descriptions and errors tell the agent not to chat, acknowledge or send follow-ups.

## How it works and what it guarantees

- Each launch gets a private Unix socket (`/tmp/pis-net-*`, mounted read-only at `/pis/net`). The **host fixes the sender** from the launching project; an agent cannot claim another identity, add fields or reach other networks.
- Messages are files under `$PIS_HOME/networks/<name>/` (`inbox/<project>/`, delivered ones moved to a bounded `archive/`, last 500 kept). Sends and deliveries are atomic renames; there are no locks that a crash could leave stale. Delivery is exactly-once per message to whoever claims it first; a message claimed by a tool call whose result is lost is not redelivered (it stays in the archive).
- Limits (see `NETWORK_LIMITS` in `src/network.js`): 4096 bytes and no control/bidi characters per message; 5 messages per recipient per 10 minutes; 20 messages per sender per hour; 20 unread per recipient. There is no hop counter yet.
- Received text is **untrusted data** from another agent: it is always wrapped in a block saying it is not an instruction from the user, grants no host approvals/permissions and may not answer the latest question. apt/Git requests still need the host confirmation.
- At start, queued messages are delivered once as **one marked prompt** (`claude`/`pi --continue "<block>"`; this starts a model turn and uses tokens) only if you gave no prompt/arguments of your own; otherwise they stay queued for `receive_messages`. They are claimed after the image is ready, immediately before the container starts. Restarts after approved apt/Git do not re-deliver.

## Not implemented / open

- Waking or restarting an idle agent, a listener mode (`--listen`), injecting messages into a running interactive session or the web UI, a hop limit, a CLI to read the log, and any agent-start capability. Idle is never treated as "finished".
- Offline tests (fake Podman, real sockets) cover config, limits, identity, MCP/Pi tool wiring and the start prompt. **Not verified on a real host:** Pi/Claude actually calling the tools, MCP loading with `PIS_NET_SOCKET`, or two real agents exchanging messages.
