# Design: outbound agent connections and a web control server

## Requested GUI follow-ups (not implemented)

- Improve the GUI's view of **how agents are working**, including delegated/parallel activity, rather than only the existing lifecycle/status/chat projection. Define bounded, content-safe activity information and distinguish running/waiting/idle from task completion; do not expose arbitrary worker state/auth/transcripts through diagnostics.
- Support **queued, editable steer messages**, similar to Pi's own interface. The user should be able to inspect and edit queued steer input before delivery. Queue ownership, bounds, generation/session changes, cancellation, delivery acknowledgement and ambiguous-outcome/no-replay behavior need a separate design; this is not permission to add an unattended supervisor or weaken host approvals.

These are future requests recorded for discovery. They are separate from the SSH connection transport currently being implemented; no activity dashboard or steer queue is claimed as available.

## Current local enrollment slice

`pis --server --standalone` and `pis --connect` implement independently started **same-host** agents. Default connect uses a saved host-global origin and registered project containing the current directory; its two-digit client code is entered under **Väntande klienter** by an authenticated admin. One-use collection then saves its private connection key/profile and starts automatically. Named/project/server overrides and explicit advanced ten-minute GUI keys remain available. Stable identity plus prior-key proof reuses offline registrations; live identities are not displaced. Advanced legacy register/run/forget remain available. The controller's registrations/sessions remain in memory; client profiles are private host files, never sandbox mounts. Server restart requires fresh approved connection requests, while normal disconnect preserves local work. No persistent transcript database, LAN/TLS listener, server container or inter-agent messaging is added. See [the current implementation/security contract](web-agents.md). The older investigation below is historical context, not a current test count or deployment claim.

## Historical investigation

The user asked to hand this work to another agent after an error/interruption. At that point only requirements/documentation investigation existed. **Continuation has now implemented local RPC and bounded text views** in `src/pi-rpc.js` / `src/pi-view.js`; see [their API, snapshot contract, limits and 33 ordinary offline tests](pi-rpc.md). An opt-in no-model RPC probe passed against installed Pi **1.5.2** (image pin remains **1.5.0**). A standalone [offline dummy backend](dummy-agent.md) plus eight subprocess tests can now stream lorem ipsum and simulate quota exhaustion/refill/resumption with the real host wait protocol, without launching Pi or making model calls. A first **optional local dummy web implementation now exists**: [start instructions, security and verification](web-control.md). `npm run web:demo` starts a loopback-only authenticated server, two outward dummy connectors and a bounded roster/chat/history/stream/stop/quota UI (assistant text now supports the safe Markdown subset documented in web-control.md) after installing the separate pinned `web/` dependency. Twenty web tests pass, including real HTTP/WebSockets, fixed dummy subprocesses, the actual app in a DOM shim and demo CLI startup/shutdown. Password hashes, machine registrations and sessions are ephemeral in-memory; persistent setup, independent multi-computer enrollment and real-container validation of the experimental registered-Pi-project mode remain pending. There was no graphical browser available. The architecture below is implemented only for this bounded same-machine dummy slice; Internet deployment, verified real-container lifecycle and remote approvals remain plans. Experimental local configured-Pi projects are now selectable via `./start_server.sh --project NAME`; the seven dedicated fake-Podman tests pass and a no-prompt real-Podman opt-in test is present but unrun. See docs/web-control.md before testing.

Repository HEAD: `740e48505174c963ba167c544a77a4d93f9e8794` (`Add named Codex accounts and quota-aware proxy failover`). Its host-approved push to `origin/main` was confirmed successful. Do not repeat that push. Previous commit `9198303` implemented staged Pi/npm updates. Working tree was clean immediately before writing this handover.

Before this new task, `npm run check` passed: **164 tests, 156 passed, 8 optional tests skipped**. The separately invoked real-installed-Pi compatibility suites passed **16/16**, using fake services only. Those historical results do not validate the new local dummy web implementation; its separate current checks are recorded in docs/web-control.md and docs/development.md.

Start with `AGENTS.md` and `docs/development.md`, then this document. Follow the host/container boundary in `docs/host-actions.md`.

## What the user wants

- A server, initially running on their laptop, later moved to a separate online server.
- Multiple pis agents, potentially on multiple computers, connect **outward** to that server. Do not expose listening ports on the agent computers to the Internet.
- A minimal browser UI with a list of agents, a quick overview of which are working, selection of an individual agent, and a chat for observing/sending messages.
- Live incremental updates while the agent works, comparable to the terminal: streamed answer/thinking content where the model exposes it, tool starts/progress/results and lifecycle status. Do not promise hidden reasoning a provider does not supply.
- Little public attack surface and authentication with a long password; Internet exposure comes after local security/UI work.
- Eventually a separate supervisory **pis agent** observes other agents and asks them to continue/handle the next task when appropriate.
- Eventually the normal typed host actions (Git push, package installation) should be available safely through the web workflow.

### Clarifications already supplied by the user

1. **Separate web-controlled mode is acceptable.** Simultaneous terminal and browser control of the same session is not required.
2. **Remote Git-push approval can wait.** They welcome an easy safe approach but do not require it in the first version. Do not weaken the existing approval contracts to deliver it quickly. Remote apt approval was not independently specified; keep unsupported host approvals unavailable until a proper workflow exists.
3. **History can be retrieved from the clients.** No durable server-side conversation store is required initially. Leave an interface for an optional server cache later.
4. **One administrator initially:** the user, controlling multiple agents. Multi-user tenancy is not needed in version one.
5. The first server runs on the laptop and is moved later. Avoid baking its address or local filesystem paths into the protocol.
6. WebRTC is acceptable if simpler; the actual requirement is real-time progress, not a particular transport.

No further product clarification is needed to start a local first version. Security/dependency details below are engineering decisions to document, not reasons to restart the requirements conversation.

## Recommended architecture discussed with the user

```text
Pi inside existing rootless pis container
  ↕ JSONL RPC over stdin/stdout
host-owned pis connector / lifecycle controller
  ↕ outbound authenticated WSS
central control server
  ↕ authenticated WSS
browser administrator
```

Use **WebSockets, not WebRTC**, for the first version. The assistant explained this choice after the user's clarification: traffic already goes through a central server, so WebRTC adds signaling/ICE and often TURN without a useful peer-to-peer advantage. WebSockets can carry incremental Pi events immediately. This is not a requirement to implement a WebSocket framing stack from scratch.

Keep these components independent:

- **Pi runtime:** model work and tools inside the existing container.
- **Host connector:** owns that container's normal lifecycle/project lock and local RPC pipes, accepts only a narrow set of remote commands, and maintains the outward connection. Real provider/Git credentials and Podman control stay here, not on the central server or inside new mounts.
- **Control server:** authenticates browser/connector roles and routes messages. No model requests, model OAuth store, Podman socket, SSH agent or general host shell is needed here.
- **Browser:** renders untrusted agent data as text, presents agent state/history and allows explicitly scoped actions.
- **Future supervisor:** another authenticated connector/agent with narrower scoped control rights, not an administrator impersonation or an approval authority.

### Suggested first-version behavior

- List connected agents and distinguish offline from idle/error; track work using lifecycle events.
- Selecting an agent requests its current state from the connector and follows live events. The user explicitly accepts limited/on-demand history; **Hämta senaste historik** requests a bounded recent view without gating state/live control.
- Stream subsequent message deltas, completed messages and tool lifecycle events.
- Send a prompt and offer cancellation. Define whether busy-time messages queue or are rejected; avoid accidental double submission.
- Closing a browser or losing the server connection must not kill/restart an ongoing Pi task. Keep draining local stdout to avoid pipe backpressure stalling Pi.
- On reconnection, resynchronize state and live sequence, discarding ambiguous partial display reconstruction. Fetch history only when explicitly requested; do **not** automatically replay prompts or host actions after an ambiguous disconnect.
- Use versioned network envelopes, unique command IDs, acknowledgements/results, bounded duplicate tracking, heartbeats, payload limits and bounded buffers. A successfully accepted prompt is not proof the task completed.
- Keep server conversation storage behind an interface. Initially no durable transcript persistence; bounded in-memory transport buffers are still sensitive data and must be described honestly.
- Agent roster labels/IDs should be bound to authenticated connector registrations, not trusted from arbitrary RPC output. A connector must not impersonate another agent.

These are implementation targets, not existing command names or protocol fields.

## Pi protocol findings (verified by reading installed documentation)

Installed/source-pinned Pi is **1.5.0**. It already supports:

```sh
pi --mode rpc
```

RPC is a long-lived subprocess protocol, **JSONL over stdin/stdout**, not native WebSocket transport. The connector can wrap it in the network protocol without parsing the TUI or importing agent/plugin packages into the host process.

Important details:

- Commands have optional string `id`; responses repeat it. Responses can arrive asynchronously/out of order. Always correlate IDs.
- `prompt` returns acceptance/queue/handled disposition, not completion. `get_state`, `get_messages`, `abort` and `clear_queue` are available.
- During streaming, `prompt` needs `streamingBehavior: "steer"` or `"followUp"` to queue work. Slash extension commands can execute immediately even during streaming; do not mistake a command allowlist for a guarantee that prompt text cannot invoke extension behavior.
- For stop/Escape semantics, `clear_queue` before `abort` matters: abort alone can leave follow-ups that continue the session.
- **`agent_end` is not idle/completion.** Retries, compaction recovery or follow-ups can continue. `agent_settled` is the lifecycle marker for no remaining automatic work. Even that means idle, not that the user's goal is complete.
- Incremental `message_update.assistantMessageEvent` has `text_delta`, `thinking_delta`, tool-call deltas and completed block events. Final `message_end.message` is authoritative and should reconcile the streamed display.
- Tools have `tool_execution_start`, `tool_execution_update`, `tool_execution_end` with correlation IDs.
- Split JSONL **only on LF**, handling optional preceding CR. Node `readline` also splits U+2028/U+2029, which are legal inside JSON strings, so is unsuitable. Handle UTF-8 chunks correctly.
- Continuously consume stdout and honor write backpressure. Stdout must contain protocol only; stderr is diagnostics, never protocol or automatically safe web content.
- `get_messages` can be large and can contain images, tool output, secrets or private code. Bound snapshots and mark truncation/omitted attachments rather than creating unbounded messages/buffers. Never put auth files/full process environments into debug logs.
- RPC includes powerful commands such as `bash`, `switch_session`, `export_html`, `set_model` and more. Do **not** expose a raw arbitrary-RPC forwarding endpoint to the browser/supervisor. Start with an explicit small allowlist.
- EOF starts orderly shutdown; signals/shutdown during active work need bounded cleanup. A network disconnect is not EOF on the local RPC process.

### Extension UI is separate from host approval

RPC supports `extension_ui_request` / `extension_ui_response`:

- Dialog methods: select, confirm, input, editor; these await a matching response.
- Notifications/widgets/status/title do not await responses.
- `ctx.hasUI` is true in RPC even though there is no TUI; `ctx.mode` is `rpc`.
- Generic extension dialogs are **sandbox-authored, untrusted content**, not verified host Git/apt approval. A malicious agent can print a fake approval-looking dialog; visual/trust separation is necessary.
- Decide and test the first-version dialog policy (support safe ordinary dialogs or explicitly cancel/report unsupported ones). Silently ignoring blocking dialogs can leave an agent stuck.

### Documentation inspected

These installed files were read in full during this investigation:

- `/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/docs/rpc.md`
- `.../docs/rpc-commands.md`
- `.../docs/json.md`
- `.../docs/rpc-extension-ui.md`
- `.../docs/cli.md`
- `.../examples/rpc-client.ts`

The docs reference `message-types.md`, session formats and examples `rpc-extension-ui.ts` / `extensions/rpc-demo.ts`. Read the relevant references/examples in full before implementing those features, as required by the harness instructions. If changing extension APIs or choosing the SDK instead, read its relevant full documentation/examples too. The SDK is not required for a host pipe adapter.

## Current pis integration points and constraints

- `src/container.js`: `piCommand()`, `interactiveOutput()`, `launchArgs()`, `launchOnce()`, `launch()`.
- `src/cli.js`: option parsing, selected-project loading and final call into `launch()`.
- `src/util.js`: `run()` forwards process signals to a child; default stdio is inherited. It does not currently expose a long-lived child handle/streams to a connector.
- `piCommand()` adds regular-TUI and session continuation defaults. Verify the exact argument construction for RPC; preserve existing terminal defaults. The CLI recognizes RPC as noninteractive via `interactiveOutput()`.
- A potential approach is a host connector spawning the existing first-party `bin/pis.js` with piped stdin/stdout and `-- --mode rpc`, thus preserving the current container/proxy/project-lock machinery. Test rather than assume that its entire stdout remains clean JSONL and that shutdown/lock cleanup works.
- Existing host proposal tools are enabled only for interactive terminal runs, not RPC/print/custom stdio. `launchOnce()` gates them using `interactiveOutput()`, stdio and TTY checks. **Do not remove those checks globally** to make web mode work.
- `src/apt-requests.js` and `src/git-push.js`: existing narrow validation, host confirmation, exact-commit push, stopped-container verification and restart notification contracts. Read `docs/host-actions.md` before any changes.
- `--auto-wait-codex` is currently explicitly unsupported in RPC/custom-stdio mode. Do not silently enable it or claim web quota continuation already works. Host-side multi-account request routing is separate and can remain in the credential proxy.
- Running updates never replace an active container. The connector must preserve this property and must not interpret network reconnection as a reason to restart the task.
- Different registered projects can run concurrently; one project's normal runtime remains exclusive. Start by requiring agents to select locally registered projects. Remote users must not be able to choose arbitrary host executables, mounts or filesystem paths.
- The repository core CLI remains dependency-free Node ES modules; host Node >=22.19, container Node 24. The optional `web/` package now pins `ws@8.23.0` and a SHA-512 lock entry; documented installation disables scripts/optional peers. It is not imported by normal `pis` or installed in container images. See [dependency/security details](web-control.md). Root checks require no live model or container engine; 15 optional web transport/app/CLI tests skip if this separate package is not installed.

## Security/deployment requirements to carry forward

- First bind the server to loopback. No Internet exposure or router changes as a development smoke test.
- Long admin password stored using an appropriate salted password hash, not plaintext in the server's authentication database. No secrets in URL/query strings or logs.
- Separate browser login credentials from per-connector machine keys; unique, revocable connector identities. Do not give every agent the admin password.
- Rate-limit login/auth attempts and bound connections, frames, message sizes, queues and reconnection backoff.
- Browser sessions need HttpOnly/SameSite cookies, CSRF/Origin checks including WebSocket upgrades, protection against DNS rebinding/Host confusion, and explicit expiration/logout behavior.
- Internet deployment requires HTTPS/WSS (for example a deliberately configured TLS reverse proxy with only its intended port public). Treat proxy headers as untrusted unless explicitly configured; don't infer external security from arbitrary headers.
- Render agent/model/tool content as untrusted text. A bounded fixed-element Markdown subset is implemented for assistant text (headings/emphasis/code), with all strings assigned via textContent. Lists, view-only task checkboxes, pipe tables and validated explicit HTTP(S) links are now supported too. Raw HTML, images, unsafe link schemes, arbitrary attributes and terminal escape interpretation remain disabled; tool/thinking/user text stays literal. Use a restrictive CSP and never automatically browse/fetch agent-supplied URLs; validated HTTP(S) links require an explicit user click and open without opener/referrer access.
- Host connector secrets must remain outside project/state/mount paths. Never mount host home, credentials, SSH agents or engine sockets as a shortcut.
- Server compromise is a serious threat because a controller can ask authorized agents to edit code/run sandbox tools. A long password alone is not sufficient Internet hardening.
- Client-fetched history reduces durable central storage, not its sensitivity: the server still receives/routes history and the browser can retain it in memory. Future caching needs explicit retention/deletion/privacy policy.

### Remote host actions (deferred)

Do not implement remote approval as chat text, raw Pi extension confirmation, arbitrary RPC `bash`, a generic host command or an agent-supplied `approved: true` field.

A later flow should bind human approval to a host-created opaque request ID, exact action/repository/remote/full commit or apt package set, expected configuration, runtime generation, expiration and one-time consumption. The host independently validates authorization and stopped-container conditions again. Reconnect must never replay a push. Supervisor credentials must not approve these requests. This needs its own tests/review before being enabled.

## Suggested implementation order / immediate next task

1. **Local foundation/views implemented:** bounded JSONL adapter, strict draft v1 control schemas and bounded allowlisted text state/history/event DTOs with omission/truncation markers, byte accounting and snapshot sequence ranges. The 33 ordinary tests cover framing, limits, correlation, backpressure, lifecycle, duplicate/ambiguous commands, process exit, projection and snapshot/live races. See [pi-rpc.md](pi-rpc.md). Requested native history now has a bounded streaming recent-tail reader; history resource limits omit only that read. The UI reads state first and automatically requests bounded recent history when opening a view, with manual refresh and no settlement-time history polling. Ordinary record framing/size limits still fault closed; permitted text remains sensitive/untrusted. These APIs are not authentication or a web endpoint. The standalone [dummy backend](dummy-agent.md) can be used as a fixed, explicitly selected local runtime when adding the connector; no arbitrary remote executable/path selection.
2. **Opt-in probe implemented and passed:** `PIS_PI_PACKAGE=... npm run test:rpc-compat` runs state/history/projected views/EOF shutdown with isolated HOME/config/cwd and blocked/audited network attempts. Tested installed Pi **1.5.2**, not the image baseline **1.5.0**. No real account or model prompt. Production Pi quota-auto in RPC is still unsupported; the dummy's separate resumption simulator must not be confused with enabling it.
3. **Startup convenience implemented:** `pis --server` (first argument) delegates to the existing local launcher with Node fallback; `pis --server --project NAME` explicitly selects registered Pi projects. **Pending isolation hardening:** current server/controller/connectors execute on the host, not in an OS sandbox. Separate the server into a least-privilege process/container without host project/auth/engine access and design protected enrollment/IPC before claiming server isolation. Real Pi tool containers are already isolated independently.

   **Local dummy slice implemented:** separate loopback server/authentication/roster and outward connectors with strict v1 command routing, hashed temporary admin auth, distinct machine keys, heartbeats, payload/queue/rate caps and no reconnect prompt replay. See [implemented limits and tests](web-control.md). Independent same-host enrollment/connector CLI is now implemented (web-agents.md). Persistent server state, independent multi-computer operation and HTTPS/WSS remain unimplemented. No public exposure.
4. **Minimal dummy UI implemented:** login, roster, selected text chat/history, streamed text/thinking/tools, send/stop, dummy quota controls and reconnect/unknown-state handling. Hostile-content, cross-agent routing, snapshot race and disconnect tests pass. Actual app-module testing uses a DOM shim; manually test layout, real-browser CSP/cookies, keyboard/mobile/accessibility and long-running lifecycle next.
5. **Experimental local integration available:** fixed first-party project RPC wrapper/connector uses existing launch/proxy/project locks, no TTY or host approvals, and retains the project lock on unconfirmed cleanup. `./start_server.sh --project NAME` selects only locally registered configured-Pi projects. Seven offline fake-Podman tests pass; the new opt-in real-Podman state/history/lock/shutdown test is **not run here**. Next verify real-container/no-model lifecycle on the host and supervise initial use before calling this production-ready.
6. Add remote approvals only after the host-action binding design is reviewed.
7. Add the supervisory agent later, with explicit task definitions, bounded continuation/model budgets, allowed target agents and no approval power. Coordinate with quota-resume/watchdog behavior; never interpret idle as proof of goal completion.

Update this feature plan and its implementation contract in `docs/web-control.md` as functionality lands; use `docs/development.md` only for a concise cross-feature map. Distinguish implemented/tested pieces from planned functionality. Do not repeat account-updater work or the already-successful push as a substitute for starting this feature.
