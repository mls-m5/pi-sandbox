# Local web control (dummy demo and experimental Pi projects)

A first browser-testable chain is implemented: authenticated loopback HTTP/WebSockets → outbound dummy connectors → local JSONL RPC → bounded text views → browser chat. The default remains token-free dummies. **Experimental locally registered Pi projects are now selectable explicitly with `--project`.** The Pi wrapper/connector path is covered by fake-Podman tests, not yet verified with a real container here. This is not an Internet or independent multi-computer deployment.

## Start and test

Run in a **host terminal in this checkout**, using Node >=22.19. If the browser is on the host, do not start this loopback server inside a sandbox: that container's 127.0.0.1 is not the host's, and this feature does not publish container ports or bypass that boundary.

```sh
# One-time optional web dependency installation; no model calls/install scripts:
npm --prefix web ci --ignore-scripts --omit=optional --no-audit --no-fund
pis --server
# Equivalent when running directly from this checkout:
./start_server.sh
```

`--server` must be the first `pis` argument. Examples: `pis --server --project my-app`, `pis --server --port 43129 --agents 3`, `pis --server --help`. This alias delegates to the same first-party Bash launcher before the normal CLI's Node-version gate, so its supported-Node/npm-Node-24 selection also works when the `pis` launcher initially selects Node 18/20. It does not import web dependencies or create a project registry to show server help. Other normal `pis` commands retain their Node requirement.

The executable Bash launcher works from any current directory, forwards demo options and uses Node >=22.19 from PATH, then a compatible bundled Node at `~/.local/share/pi-node/current/bin/node`. If neither qualifies (including a bundled Node 20), it uses `npm exec --yes --package=node@24 -- node ...`; this may download Node into npm's cache on first use, without changing system/bundled Node or shell configuration. A working npm is required for that fallback. It never installs web dependencies automatically or overrides npm engine policy. `./start_server.sh --help` needs no dependency/download/password. If a supported Node is already selected, `npm run web:demo` remains equivalent.

At the terminal prompt, either choose a unique temporary administrator password of **at least 20 characters**, or press **Enter with no text** to generate a random **256-bit (43-character base64url)** password. The generated password is deliberately displayed **once on stderr after the server has bound its port** so you can copy it into the browser. It is not stored in a file or sent to the browser automatically. **It is visible to screen sharing/terminal recordings and any redirected stderr/log capture.** A supplied nonempty password remains hidden and is never printed; short/invalid nonempty passwords are rejected, not silently replaced. Do not reuse provider credentials or paste an API key. Open **http://127.0.0.1:43128**, not `localhost` (Host/Origin are intentionally exact), and log in with that password. The first agent opens automatically; optionally choose Dummy 2, send a message and observe incremental lorem ipsum and no-op tool events. The demo makes no model requests, launches no Pi CLI/Podman, reads no provider credentials and has no real-provider fallback.

Click **Simulera kvotstopp 5 s** to see the failed message, synthetic waiting state and one continuation after fresh available usage. The text input also supports:

```text
/dummy quota hold
/dummy refill
/dummy cancel
/dummy auto off
/dummy auto on
/dummy transient
/dummy error
```

See [the dummy's exact semantics and limitations](dummy-agent.md). Simulator controls can require a state refresh before the next prompt; the UI does this for handled commands. Busy-time messages are rejected/disabled rather than queued. **Stoppa** clears queues before aborting and cancels a pending synthetic quota continuation.

Options:

```sh
./start_server.sh --port 43129 --agents 3
```

The demo supports 1–8 dummy runtimes, binds **only 127.0.0.1**, and has no public-listen option. For a deliberate headless test, `node web/cli.js demo --password-stdin` reads one password line from stdin; do not put passwords in command arguments, URLs or shell history. Default interactive input is hidden. An empty line or EOF with explicit `--password-stdin` also requests generation and prints the generated password to stderr; do not use that form if stderr is collected in logs you cannot protect. Empty **browser** login remains invalid and does not generate or bypass anything. Ctrl-C/SIGTERM/SIGHUP close the connectors, dummy processes and server.

Password hashes, per-connector keys, browser sessions, conversations and synthetic quota state are **in memory only**. Nothing is saved to project config, PIS_HOME, auth files or a server transcript database. Restarting the demo resets everything and asks for a new temporary password. The CLI never prints connector machine keys or supplied passwords and does not persist a registration database. The only intentional exception is a newly generated admin password, displayed once when empty CLI input requests it. Only its salted scrypt hash is retained by the server; terminal/log history may retain the displayed secret outside pis. Persistent setup, independently operated connector CLI/enrollment and moving the server between machines remain future work. Real Pi projects differ from the dummy: their normal sandbox session/project state persists in existing pis storage, while web authentication and transport state remain ephemeral.

## Experimental real Pi projects (local host only)

Stop any terminal session already using the intended project first: one project remains exclusive. In a **host terminal**, list existing registrations and select explicitly:

```sh
pis --list
pis --server --project my-app
# Multiple independent registered projects:
./start_server.sh --project my-app --project other-app --port 43129
# With a supported Node selected, equivalent:
npm run web:start -- --project my-app
```

These names/IDs must already exist in the same host `PIS_HOME` as normal `pis`; no project is registered or configuration rewritten automatically. Only projects configured with `agent: "pi"` are accepted. No Claude override, arbitrary executable/path, remote project selection, model/session startup args, mixed dummy/Pi list or remote mount control is supported. Omit `--project` for the dummy demo. `npm run web:demo` deliberately remains dummy-only.

**Real Pi prompts can spend subscription quota or API credits and edit mounted project files.** The host prints a cost warning and the UI labels real Pi agents; dummy-only quota simulation buttons are hidden for them. The connector sends only `get_state` during startup, not an initial prompt; normal configured extensions or restored Pi behavior can independently cause model activity. It continues the latest session using existing Pi defaults. It does not attach to an already running terminal Pi process. Configured model/provider/proxy/mount settings and persisted session state are preserved. The web server receives bounded text views, never the project's provider credentials. Its ephemeral machine registrations are created by the local host, not agent event claims.

The first-party `bin/pis-project-rpc.js` wrapper uses existing `launch()`/Podman image selection, host provider proxy and exclusive project locks. It rechecks the configured agent under lock. Stdio is pipes/RPC without TTY; image build output stays on stderr, not protocol stdout. Credential forwarding restrictions remain unchanged. The new mode adds no host mounts/sockets/agents, bypass flags or remote shell. Git/apt proposal tools and `--auto-wait-codex` remain unavailable in web/RPC; native sandbox tools/ordinary untrusted extension commands still work. Account proxy routing is independent of continuation.

### Startup status: what are we waiting for?

The URL message means the **web server is already listening**. Open it and log in immediately; you do not have to wait in the terminal. Select a project to see its startup phase. Offline/starting agents cannot accept prompts. The roster and selected-agent area show fixed host-authored stages: queued, host wrapper/project lock, Podman checks, image preparation, image ready, credential proxy (if configured), container/Pi/extensions, Pi RPC response and confirmed agent registration. Preparing the image may include downloads/build work; it is not a percent-complete or remaining-time estimate.

Each terminal transition includes elapsed seconds; while startup is pending the terminal prints a ten-second waiting heartbeat. The GUI updates elapsed seconds locally and notes if no new step has arrived for 15 seconds. That does not prove a deadlock: a build or extension load can legitimately take time. A busy project gets a specific host status. Startup failures now retain a fixed actionable phase: busy project, Podman check, image/build, proxy, Pi exit, malformed RPC, timeout or registration failure. The server remains running after a project startup failure so its error remains visible in the GUI with send disabled, and other selected projects can still start. There is no automatic process retry or GUI retry button; correct the host cause and restart the web command when safe. Raw build output/auth errors/stderr are **not forwarded into chat or the browser**. A dedicated bounded host-only fd 3 carries just allowlisted phase codes from the first-party wrapper to the connector; no extra container mount or RPC/model message is used.

`connection(s) ready` now waits for the server's authenticated registration acknowledgement **after** Pi responds. It means server and agent connection are running, not task completion. At that point the terminal stays open without returning a shell prompt because it is running the server; that is normal. The final message explicitly says to open the URL, log in and choose the project. A later disconnected agent is shown as reconnecting/offline, never as still starting or still connected based on an old startup marker.

Image build/startup can take minutes; the connector allows up to ten minutes for initial state and eight seconds for initial authenticated agent registration. On startup failure there is no automatic retry of the local process. Diagnose the project with normal host `pis` and its lock/Podman/config commands. Other project lock holders are refused, not killed/unlocked. The browser disconnect/reconnect never tears down or restarts Pi. To shut down all local web sessions, use Ctrl-C in the launcher terminal; the connector requests clear-queue/abort, closes stdin and allows the wrapper about a minute for termination and independent container removal/existence checks. An unclean wrapper exit is not reported as successful cleanup. If shutdown cannot confirm the container is gone, the **project lock is retained**, even after its wrapper exits: inspect on the host and use the existing conservative `pis --unlock --dry-run` / `pis --unlock` workflow only when safe. Do not delete locks or kill the host launcher just to skip those checks.

Verification is deliberately limited: nine offline project tests use fake Podman and a synthetic native RPC subprocess to exercise registration/config preservation, Claude/config-race rejection, clean build/protocol streams, exclusive locks, unknown-cleanup lock retention, reconnect without a new run, actual web CLI project startup/shutdown and successful final cleanup. They do not execute real Pi or prove production container/proxy lifecycle. A new opt-in `PIS_INTEGRATION=1 node --test test/project-rpc-integration.test.js` exercises real rootless Podman state/history/lock/EOF cleanup with fresh credential-free state and **no model prompt**; it is present but **not run here**. First real-project use should be supervised; full stream/provider/browser lifecycle still needs real-container verification.

## Troubleshooting state/history without sharing private folders

First isolate the common browser/server/RPC path using the dummy; it needs no provider credentials or model quota. Stop the previous server with Ctrl-C and wait for cleanup, close old tabs, then run on the host:

```sh
pis --server --diagnostics --agents 1
# Or, explicitly from this checkout:
./start_server.sh --diagnostics --agents 1
```

Open **http://127.0.0.1:43128**, log in with this start's password and choose Dummy 1. The first agent opens automatically. Opening/reopening an online agent or reconnecting reads **state first**, then automatically requests bounded recent history. Live events continue during the history read; fresh idle state enables sending without waiting for history. Offline/startup views wait for the agent to connect. Use **Hämta senaste historik** to refresh or retry manually; failed/over-limit automatic reads are not retried in a loop. If it fails, expand **Anslutningsdiagnostik · utan chattinnehåll**. Share just the action/code/reference line (for example `state · kod=rpc_unavailable · ref=0123456789ab`) and matching terminal lines beginning **`pis web diagnostic:`**. Do not send the whole terminal output: empty CLI password input deliberately prints a generated admin password separately. Do not share auth/state/log directories, transcripts, HAR exports, headers, raw RPC or raw stderr. There is no automatic diagnostic log folder.

`--diagnostics` is optional/off by default and works with dummies or `--project`. It emits only allowlisted event/action/error names, generated short references, timestamps, bounded durations and snapshot-stability flags. No project labels/paths, sessions, emails, headers, password/machine keys, prompts, history or arbitrary native error text are logged. At most 120 records/minute plus one limit notice are written; wait for the next window for a fresh trace if limited. Sink failure cannot break RPC draining. The GUI keeps at most twenty action/code/reference lines in memory even without the flag; no localStorage/files are used.

A normal read follows `server:command_routed` → `connector:command_received` → `connector:command_result` → `server:command_result`, sharing a short reference. Success is `code=ok`; duplicates never re-execute. Useful fixed codes:

- `not_connected_or_busy`: the browser could not route the command because its connection/queue was not ready.
- `agent_offline` / `control_stale_generation`: disconnected/changed runtime; no prompt replay.
- `rpc_unavailable`: local adapter closed/faulted/stopping; look for an earlier `connector:rpc_fault` or `rpc_closed` event.
- `rpc_invalid_record`, `rpc_response_mismatch`, `rpc_record_too_large`: native framing/response/ordinary-record bound failure. These safety checks remain for malformed or ordinary non-history records.
- `rpc_history_limit`: a requested native history exceeded the bounded streaming reader's individual-message/record/depth/suffix budget. Only that read is discarded through LF; live/control remains available. No session is modified.
- `pi_command_rejected`: Pi returned a native failure; raw provider/extension text stays hidden.
- `invalid_state_reply`: successful response lacked expected streaming/compaction/queue fields. The GUI does not guess idle or enable send from that state.
- `outcome_unknown` / `rpc_timeout_ambiguous`: a deadline/disconnect prevented a confirmed result; no automatic mutation retry.

401 on `/session` **before login** is expected (`login_required`); after login it becomes `authenticated`. Refused HTTP connection means server unreachability, not an agent Codex-auth error. If the dummy also fails, diagnose this common path before touching real Codex accounts/projects. Passing automated tests is not a diagnosis of the reported host issue; actual host browser behavior remains unconfirmed until these codes are collected.

## Work indicators and tool results

The agent status has a rotating CSS indicator and a text label while working (or waiting for synthetic dummy quota). It stops on `agent_settled`, **not** merely `agent_end`. Idle means no current runtime work, not that the task succeeded; reported errors, abortion, offline and unknown state are labelled separately. Reduced-motion preferences disable rotation without hiding the text status.

Tool calls and results are correlated by the bounded projected `toolCallId`/call ID, including saved history. The chat renders **one card per correlated call**, with its literal output in the same card: dashed amber while running, solid **blue** on completion, solid **red** when the tool reports `isError`. A result whose call was omitted from recent history still gets one self-contained card. Missing IDs cannot be reliably merged. Arguments remain omitted, tool results are not Markdown/HTML, and live output remains capped at 2048 characters per tracked call (at most 20 live calls); existing message/history caps still apply. The collapsed tools overview is an optional second view of those calls, not another execution.

A missing completion after settlement, sequence gaps, runtime faults or disconnection is **unknown**, not successful and not an endless spinner. Reopening a history view cannot establish that an old result-less call is still running. Historical results remain blue/red even without live events. Automated tests cover correlation, live updates, errors/history, interruptions, agent-end versus settlement, literal hostile output and reduced-motion CSS; real graphical appearance remains a manual verification gate.

## Basic Markdown in assistant replies

Assistant **text** blocks, both live partials and final/history messages, support a small dependency-free Markdown subset:

- ATX headings `#` through `######` (space after the hashes).
- `*italic*` / `_italic_` and `**bold**` / `__bold__`, including simple nested emphasis.
- Fenced code using triple backticks or tildes; an optional language name is displayed as plain text. No syntax-highlighting code is downloaded/executed. An unfinished streamed fence safely renders the remaining text as code until its closing fence arrives.
- Inline backtick code and escaped emphasis markers.
- Bullet (`-`, `+`, `*`) and numbered (`1.` / `1)`) lists, including simple indentation-based nesting (up to four levels).
- Task items `- [ ] Pending` / `- [x] Done`, rendered as **disabled, read-only checkboxes**. Clicking them cannot mutate a session, send a command or spend tokens.
- Pipe tables with a header and `---` separator row, optional colon alignment, escaped `\\|` and code-span pipes. At most twelve columns and 64 rows are formatted per table; mismatched rows remain visible as text instead of silently losing extra cells.
- Explicit Markdown links `[label](https://example.org/path)` and angle autolinks `<https://example.org>`. Only absolute `http`/`https`, with no embedded username/password or raw whitespace/control/backslash, are clickable. Destinations are normalized through URL parsing, capped at 2048 characters, and labels at 512 characters. Link labels can have simple inline formatting, not nested links. Bare URLs and relative/file/mailto/javascript/data destinations remain text.

Clickable links open in a **new tab** with `rel="noopener noreferrer"` and `referrerPolicy="no-referrer"`; the hover title identifies the normalized destination origin. A link is untrusted agent-authored navigation, not a safety endorsement of that website. No server/browser fetch, embed, remote highlight or automatic navigation is triggered merely by rendering a link; following it is the user's explicit action. Images remain disabled.

This is not a full CommonMark parser: raw HTML, arbitrary styles/attributes, images, link titles/reference links, general multiline list continuations and executable content are not enabled. Unsupported/over-budget formatting remains text; complex delimiter nesting may remain literal. User messages, thinking and tool output deliberately remain plain/preformatted text. Source characters, block count, list/table dimensions, formatting-node budget and nesting depth remain bounded. Content strings use `textContent` in fixed allowlisted elements; the only dynamic navigation property is a separately validated HTTP(S) href. No HTML parsing/sanitizing pipeline, remote assets or terminal interpretation is used. Existing CSP and history/chat-memory caps are unchanged. Tests cover formatting, streamed reconciliation, fences, hostile HTML/URLs and bounds; graphical layout still needs manual browser verification.

## Components and dependency boundary

- `web/server.js`: separate HTTP/WebSocket server, hashed admin authentication, cookie sessions, authenticated agent roster, scoped command routing and live forwarding. No Pi/provider/Git/Podman capability is supplied to this server.
- `web/connector.js`: outward-only network connection wrapping an existing `PiView`; the demo helper spawns **only the fixed first-party dummy executable**; `web/project-connector.js` can instead spawn the fixed first-party registered-project wrapper after explicit local selection. A remote message cannot select an executable, project directory, mount or native RPC method.
- `web/public/`: a static login/roster/chat UI, bounded chat model and safe fixed-element Markdown renderer for assistant text. Authoritative final messages replace streamed partials; tools and provider-exposed thinking are displayed only as untrusted text. Native metadata/attachments remain omitted by `PiView`.
- `web/cli.js`: temporary local setup, memory-only random distinct connector keys and a hidden password prompt. It starts two outbound dummy connections by default, or explicitly selected local Pi projects in `start --project` mode.

The core CLI remains dependency-free. The **optional `web/` package** pins maintained `ws@8.23.0` with a committed SHA-512 npm lock entry; it does not implement WebSocket framing itself. Only `ws` is installed, with scripts/optional native peers omitted in the documented install command. Normal `pis` and container images do not import this package or install its dependencies. Registry/version and API were checked against [npm metadata](https://registry.npmjs.org/ws/8.23.0) and [ws API documentation](https://github.com/websockets/ws/blob/master/doc/ws.md) during implementation. This is not a promise that the version will remain current or vulnerability-free; review updates before future Internet deployment.

## Isolation boundary and pending hardening

The **web server runs as your host user, not in a container/sandbox**. Loopback binding/authentication limits access but is not process isolation: do not describe the server as sandboxed. Dummy processes and host connectors are also ordinary host Node processes; real Pi tools still run inside existing rootless Podman project containers. The server and connector are separate modules/process roles but the convenience CLI currently loads server/connector code in one host process, so their credential separation is not an OS security boundary.

**Pending:** split and sandbox the server as a separate least-privilege process/container without host project/auth/Podman access, and define protected local enrollment/IPC to host connectors. Review required mounts, credential stores, lifecycle and TLS before implementing this; do not mount host home, OAuth files, agents or engine sockets as a shortcut. This remains future hardening and is not silently enabled by `pis --server`.

## Authentication and bounds

- Admin passwords use salted **scrypt N=32768/r=8/p=1**, 64-byte derived hashes and timing-safe comparison. Only hashes/salts are held by the server; plaintext exists transiently during input/login. Authentication allows two concurrent hash operations and ten login attempts/minute globally. This intentionally simple local limit can deny service to the sole admin if another local caller exhausts it.
- Each connector uses a separate random 256-bit bearer key in the upgrade **Authorization header**, never in URLs. The server holds only key hashes, binds roster identity/label to its registration, refuses concurrent reuse and supports in-memory revocation. A connector cannot return a result on another connector's route. The demo creates these registrations internally; there is no remote enrollment/approval endpoint.
- Browser sessions use random 256-bit tokens, HttpOnly/SameSite=Strict/path cookies, server-side eight-hour expiration and explicit logout invalidation, including connected sockets. Cookies deliberately lack Secure **only because this version is loopback HTTP**; there is no supported public HTTP or reverse-proxy configuration. Login/logout enforce exact Origin and JSON/custom-header checks; logout also requires the session CSRF token. Browser WS upgrades require the exact Origin and cookie; machine upgrades reject browser Origin/cookies. Host is exact on HTTP and upgrades; query credentials, proxy-header origin inference, CORS and arbitrary static paths are not supported.
- CSP is restrictive: scripts/styles only from self, no inline code, no framing, no base/form destinations and only the local WebSocket origin for connections. Responses are no-store/nosniff/no-referrer. Agent text uses textContent/preformatted content or the bounded fixed-element Markdown subset, never raw HTML, unsafe link schemes, images, `eval` or terminal interpretation. Validated HTTP(S) links require an explicit user click in a separate tab without opener/referrer access. UI data/credentials are not placed in localStorage/sessionStorage. This is not a secret redactor: legitimate text can still contain sensitive material.
- Limits: 32 registered agents/server API (demo 8), 8 browser sockets, 16 sessions, HTTP server connection cap 64, 8 KiB headers/login body cap, 10-second HTTP header/request deadlines, 60 upgrade attempts/minute globally. WS payload max 272 KiB, 128 fragments, 512 buffered chunks, compression disabled, outgoing buffer cap 512 KiB. Slow peers are disconnected rather than allowed to stall local RPC. Browser application messages are capped at 30/sec and agent messages at 500/sec, with ping/pong budgets. Heartbeats run every ten seconds; connectors also detect 45 seconds without server activity.
- Pending routes: at most 128 globally, 8/browser and 16/agent, with a 35-second result deadline. The server retains only command identity/action/generation for routing, not a durable conversation log. Pending network buffers still contain sensitive data. Browser selection/disconnect drops observer routes, not local execution. Native view/JSONL/history ceilings and the 4096-command generation tombstone limit still apply; see [RPC/view contracts](pi-rpc.md).

## Reconnection and outcomes

Network loss never closes the local runtime's stdin, restarts a child or resets `PiControl`/`PiView`. Connectors continue draining local events, drop unsent data and reconnect with bounded jitter/backoff; they never queue/replay commands or old replies on a new connection. The authenticated roster supplies the current generation/sequence on reconnect, and the UI fetches fresh state and bounded recent history for the current selection and resumes live events. An ambiguous result is shown as unknown, not automatically retried with a fresh ID.

The UI subscribes before snapshot requests, checks snapshot generation/sequence/stability and flags racing/missing data rather than blindly merging overlapping history with live deltas. The first roster agent is selected automatically (including a startup/offline view); an existing manual selection is preserved across roster updates and reconnection while it still exists. Opening/reopening an online agent, agent registration/new generation or browser reconnection reads state first and automatically requests history once. Settlement/status checks query only state, not history: there is no continuous history polling or automatic retry after a failed read. **Hämta senaste historik** remains a manual refresh/retry. Both automatic and manual history reads retain at most the newest 100 messages / 1 MiB raw retained history before the 256 KiB projected view cap; omissions/truncation are labelled. Each history read may still cause native Pi to serialize/transmit its full response, but host buffering is bounded. A single native message above 4 MiB, aggregate above 128 MiB or other reader resource limit yields a nonfatal history omission rather than poisoning the adapter. During continuous activity a manual snapshot can remain explicitly unsynchronized; ask again when desired/idle. Fresh state/live control does not require historical completeness. Session files and Pi's own context/compaction policy are unchanged. Conversation indices are snapshot-local, not persistent message IDs. Closing a browser/logout does not stop running dummy tasks; stopping the entire demo does.

Status/idle means no pending automatic runtime work, **not task success**. A successful prompt result reports acceptance/disposition, not completion. Agent/model/tool content and even synthetic quota events cannot authorize a host action. The server compromise threat remains serious for any future real-agent control.

## Verification and remaining work

```sh
npm run test:web
npm run check
```

**42 web tests pass** with the optional dependency installed. They use real loopback HTTP/WebSockets and fixed dummy subprocesses, covering authentication/rate limits, Host/Origin/CSRF/cookie/logout/expiry, payload bounds, cross-agent routing/forgery rejection, stale generations, ambiguous deadlines, key revocation, streaming, stop, browser/connector disconnect and same-runtime quota resumption. Pure UI tests cover authoritative final reconciliation, snapshot races, memory bounds and hostile text rendering. One integration test runs the **actual app module in a DOM shim**, exercises login/select/chat/quota/logout through real transports; another starts and shuts down the actual demo CLI, checking that secrets do not appear in output.

Five additional offline launcher tests use fake Node/npm executables to cover compatible PATH/bundled selection, the Node 24 fallback, missing tools/dependencies, paths with spaces, option forwarding and help without downloads. The fallback's exact invocation is tested without making npm downloads in fast checks.

No graphical browser was available here: actual layout, browser CSP/cookie behavior, keyboard/mobile/accessibility and long-running tab lifecycle still need manual testing. The app-module test also observes pre-connection image/container stages with send disabled, followed by normal readiness; wrapper tests assert ordered allowlisted progress and registration-before-ready. The DOM shim is not a browser certification or full XSS audit. With no `web/node_modules/ws`, root checks still run core/pure UI/auth tests and explicitly skip 15 optional web transport/app/CLI tests (plus two optional project-web connector/CLI tests); install the pinned package to run them. All tests are free of paid/live model calls.

Still pending: persistent enrollment/secret storage and login maintenance, independent multi-computer connector operation, real-container validation/hardening of the experimental registered-project connector, native-side history paging and broader large-session validation, optional server cache interface, production quotas in RPC, real browser automation/verification and broader hardening/review. HTTPS/WSS deployment and Internet exposure are **not supported yet**. Remote Git/apt approvals and a supervisor remain deferred; existing terminal-only host approval and production quota-auto gates are unchanged.
