# Agent message network (experimental)

Running agents in **different registered projects** can exchange short messages through the host. This is not `pi-subagents` (children inside one agent). Live delivery can trigger a model turn in a running Pi session, but never starts or stops another container.

## Setup

Give each project the same network name in `pis --edit`:

```json
{ "network": "team-a" }
```

`pis --list` shows the network as a fourth tab-separated column (`-` when none). Names are lowercase letters, digits and dashes (max 32). Without the field nothing changes. Projects with the same name are peers; addresses are project names (or IDs). `pis --new --from OLD` copies the network and any explicit `networkPush` setting.

For running terminal Pi sessions, setting `network` also enables automatic inbox checks (about every two seconds). A message can start a model turn while Pi is idle, consuming tokens; while Pi is working, it is delivered as native steering. Set `"networkPush": false` to disable live delivery while retaining manual reads and the existing startup inbox prompt. This takes effect at the next launch. Live delivery does not apply to print mode or web RPC. Claude Code cannot be pushed to (the pinned 2.1.328 has no channel/injection flag), so it gets **hook delivery** instead, see below. The poller skips checks while the manual receive tool is waiting.

Peer lookup reads only `id`, `name`, `root`, `network` and `agent` from each project file and ignores everything else; it does not use the strict configuration validator. A `pis` process started before an upgrade therefore keeps delivering messages even though newer pis versions have written fields it does not know (for example `examples.networkWake`). Unreadable project files just stop being peers. Code changes still reach an already running agent only after it is restarted.

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

## Claude Code: hook delivery (experimental)

Unless `"networkPush": false`, an interactive or print Claude launch on a network also passes `--settings` with three hooks from the image (`/opt/pis/claude-network-hook.mjs`): `PostToolUse` and `UserPromptSubmit` add queued messages as extra context, and `Stop` blocks Claude from going idle while messages are queued so it keeps working on them. This reacts at Claude's natural boundaries; it cannot wake a Claude that is idle at the prompt. The hook only reads the host socket, prints nothing when the queue is empty, and fails silently. Texts carry the same untrusted-data header. Messages are claimed by whichever reader (hook, `receive_messages`) gets them first, once.

### Waking an idle Claude (`networkWake`, default on)

Hooks cannot run while Claude sits idle at its prompt. The `Stop` hook therefore also tells the host (op `state`, only an idle/busy hint over the same socket) when Claude has finished a turn with nothing to continue on, and `UserPromptSubmit`/`PostToolUse` report busy. If an **interactive** Claude has been idle for about a minute (`WAKE_IDLE_MS`) and messages are queued, the host stops its container (`podman stop`, 5 s grace), verifies it is gone and restarts it with `claude --continue "<marked notice>"`, the same mechanism as after approved apt/Git requests. The notice says the messages arrived while Claude was idle and that pis restarted it. It uses one model turn per wake and only ever fires with queued messages, so it cannot loop without new messages (senders are rate limited; there is still no hop limit).

**Trade-off:** pis cannot see whether you are typing in the Claude window. A wake kills the session mid-input and discards any unsent text. Set `"networkWake": false` to disable it, or `"networkPush": false` to disable hooks (and therefore wake) altogether. Not applied to print mode, Pi (an idle Pi gets a new turn via push instead) or web RPC. Idle is only a hint and is never treated as "finished".

**Not verified:** the hook JSON shapes (`additionalContext`, `decision: "block"`) and that `--settings` merges with project settings were written from Claude Code's hook conventions, not exercised against 2.1.328 with a model, because that needs a real session. Verify on the host: send a message to a busy Claude and check it appears after the next tool call; send one to an idle Claude and confirm that it is read only on the next prompt.

## Not implemented / open

- Starting a container that is not running, a host listener mode (`--listen`), live delivery in the web UI, a hop limit, a CLI to read the log, and any agent-start capability. Idle is never treated as "finished".
- Offline tests (fake Podman, real sockets) cover config, limits, identity, MCP/Pi tool wiring, the start prompt and live inbox polling. **Not verified on a real host:** live delivery triggering a real Pi model turn, MCP loading with `PIS_NET_SOCKET`, or two real agents exchanging messages.
