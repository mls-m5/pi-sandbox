# Local web control demo (dummy agents only)

A first browser-testable chain is implemented: authenticated loopback HTTP/WebSockets → outbound dummy connectors → local JSONL RPC → bounded text views → browser chat. **Only offline dummy runtimes are selectable.** This is not yet real-container Pi web mode or an Internet deployment.

## Start and test

Run in a **host terminal in this checkout**, using Node >=22.19. If the browser is on the host, do not start this loopback server inside a sandbox: that container's 127.0.0.1 is not the host's, and this feature does not publish container ports or bypass that boundary.

```sh
# One-time optional web dependency installation; no model calls/install scripts:
npm --prefix web ci --ignore-scripts --omit=optional --no-audit --no-fund
./start_server.sh
```

The executable Bash launcher works from any current directory, forwards demo options and uses Node >=22.19 from PATH, then a compatible bundled Node at `~/.local/share/pi-node/current/bin/node`. If neither qualifies (including a bundled Node 20), it uses `npm exec --yes --package=node@24 -- node ...`; this may download Node into npm's cache on first use, without changing system/bundled Node or shell configuration. A working npm is required for that fallback. It never installs web dependencies automatically or overrides npm engine policy. `./start_server.sh --help` needs no dependency/download/password. If a supported Node is already selected, `npm run web:demo` remains equivalent.

Choose a unique temporary administrator password of **at least 20 characters** at the hidden terminal prompt; do not reuse provider credentials or paste an API key. Open **http://127.0.0.1:43128**, not `localhost` (Host/Origin are intentionally exact), and log in with that password. Choose Dummy 1 or Dummy 2, send a message and observe incremental lorem ipsum and no-op tool events. The demo makes no model requests, launches no Pi CLI/Podman, reads no provider credentials and has no real-provider fallback.

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

See [the dummy's exact semantics and limitations](dummy-agent.md). Simulator controls can require a state/history refresh before the next prompt; the UI does this for handled commands. Busy-time messages are rejected/disabled rather than queued. **Stoppa** clears queues before aborting and cancels a pending synthetic quota continuation.

Options:

```sh
./start_server.sh --port 43129 --agents 3
```

The demo supports 1–8 dummy runtimes, binds **only 127.0.0.1**, and has no public-listen option. For a deliberate headless test, `node web/cli.js demo --password-stdin` reads one password line from stdin; do not put passwords in command arguments, URLs or shell history. Default interactive input is hidden. Ctrl-C/SIGTERM/SIGHUP close the connectors, dummy processes and server.

Password hashes, per-connector keys, browser sessions, conversations and synthetic quota state are **in memory only**. Nothing is saved to project config, PIS_HOME, auth files or a server transcript database. Restarting the demo resets everything and asks for a new temporary password. The CLI does not print machine keys/passwords or persist a registration database. Persistent setup, independently operated connector CLI/enrollment and moving the server between machines remain future work.

## Components and dependency boundary

- `web/server.js`: separate HTTP/WebSocket server, hashed admin authentication, cookie sessions, authenticated agent roster, scoped command routing and live forwarding. No Pi/provider/Git/Podman capability is supplied to this server.
- `web/connector.js`: outward-only network connection wrapping an existing `PiView`; the demo helper spawns **only the fixed first-party dummy executable**. A remote message cannot select an executable, project directory, mount or native RPC method.
- `web/public/`: a static login/roster/chat UI, bounded chat model and text-only renderer. Authoritative final messages replace streamed partials; tools and provider-exposed thinking are displayed only as untrusted text. Native metadata/attachments remain omitted by `PiView`.
- `web/cli.js`: temporary local setup, memory-only random distinct connector keys and a hidden password prompt. It starts two outbound dummy connections by default.

The core CLI remains dependency-free. The **optional `web/` package** pins maintained `ws@8.23.0` with a committed SHA-512 npm lock entry; it does not implement WebSocket framing itself. Only `ws` is installed, with scripts/optional native peers omitted in the documented install command. Normal `pis` and container images do not import this package or install its dependencies. Registry/version and API were checked against [npm metadata](https://registry.npmjs.org/ws/8.23.0) and [ws API documentation](https://github.com/websockets/ws/blob/master/doc/ws.md) during implementation. This is not a promise that the version will remain current or vulnerability-free; review updates before future Internet deployment.

## Authentication and bounds

- Admin passwords use salted **scrypt N=32768/r=8/p=1**, 64-byte derived hashes and timing-safe comparison. Only hashes/salts are held by the server; plaintext exists transiently during input/login. Authentication allows two concurrent hash operations and ten login attempts/minute globally. This intentionally simple local limit can deny service to the sole admin if another local caller exhausts it.
- Each connector uses a separate random 256-bit bearer key in the upgrade **Authorization header**, never in URLs. The server holds only key hashes, binds roster identity/label to its registration, refuses concurrent reuse and supports in-memory revocation. A connector cannot return a result on another connector's route. The demo creates these registrations internally; there is no remote enrollment/approval endpoint.
- Browser sessions use random 256-bit tokens, HttpOnly/SameSite=Strict/path cookies, server-side eight-hour expiration and explicit logout invalidation, including connected sockets. Cookies deliberately lack Secure **only because this version is loopback HTTP**; there is no supported public HTTP or reverse-proxy configuration. Login/logout enforce exact Origin and JSON/custom-header checks; logout also requires the session CSRF token. Browser WS upgrades require the exact Origin and cookie; machine upgrades reject browser Origin/cookies. Host is exact on HTTP and upgrades; query credentials, proxy-header origin inference, CORS and arbitrary static paths are not supported.
- CSP is restrictive: scripts/styles only from self, no inline code, no framing, no base/form destinations and only the local WebSocket origin for connections. Responses are no-store/nosniff/no-referrer. Agent text uses text nodes/preformatted content, not HTML/Markdown, links, `eval` or terminal interpretation. UI data/credentials are not placed in localStorage/sessionStorage. This is not a secret redactor: legitimate text can still contain sensitive material.
- Limits: 32 registered agents/server API (demo 8), 8 browser sockets, 16 sessions, HTTP server connection cap 64, 8 KiB headers/login body cap, 10-second HTTP header/request deadlines, 60 upgrade attempts/minute globally. WS payload max 272 KiB, 128 fragments, 512 buffered chunks, compression disabled, outgoing buffer cap 512 KiB. Slow peers are disconnected rather than allowed to stall local RPC. Browser application messages are capped at 30/sec and agent messages at 500/sec, with ping/pong budgets. Heartbeats run every ten seconds; connectors also detect 45 seconds without server activity.
- Pending routes: at most 128 globally, 8/browser and 16/agent, with a 35-second result deadline. The server retains only command identity/action/generation for routing, not a durable conversation log. Pending network buffers still contain sensitive data. Browser selection/disconnect drops observer routes, not local execution. Native view/JSONL/history ceilings and the 4096-command generation tombstone limit still apply; see [RPC/view contracts](pi-rpc.md).

## Reconnection and outcomes

Network loss never closes the local runtime's stdin, restarts a child or resets `PiControl`/`PiView`. Connectors continue draining local events, drop unsent data and reconnect with bounded jitter/backoff; they never queue/replay commands or old replies on a new connection. The authenticated roster supplies the current generation/sequence on reconnect, and the UI fetches fresh state/history. An ambiguous result is shown as unknown, not automatically retried with a fresh ID.

The UI subscribes before snapshot requests, checks snapshot generation/sequence/stability and flags racing/missing data rather than blindly merging overlapping history with live deltas. It tries up to three read-only synchronizations per activity episode/selection and offers manual **Hämta historik**. During continuous activity history can remain explicitly unsynchronized until idle. Conversation indices are snapshot-local, not persistent message IDs. Closing a browser/logout does not stop running dummy tasks; stopping the entire demo does.

Status/idle means no pending automatic runtime work, **not task success**. A successful prompt result reports acceptance/disposition, not completion. Agent/model/tool content and even synthetic quota events cannot authorize a host action. The server compromise threat remains serious for any future real-agent control.

## Verification and remaining work

```sh
npm run test:web
npm run check
```

**20 web tests pass** with the optional dependency installed. They use real loopback HTTP/WebSockets and fixed dummy subprocesses, covering authentication/rate limits, Host/Origin/CSRF/cookie/logout/expiry, payload bounds, cross-agent routing/forgery rejection, stale generations, ambiguous deadlines, key revocation, streaming, stop, browser/connector disconnect and same-runtime quota resumption. Pure UI tests cover authoritative final reconciliation, snapshot races, memory bounds and hostile text rendering. One integration test runs the **actual app module in a DOM shim**, exercises login/select/chat/quota/logout through real transports; another starts and shuts down the actual demo CLI, checking that secrets do not appear in output.

Five additional offline launcher tests use fake Node/npm executables to cover compatible PATH/bundled selection, the Node 24 fallback, missing tools/dependencies, paths with spaces, option forwarding and help without downloads. The fallback's exact invocation is tested without making npm downloads in fast checks.

No graphical browser was available here: actual layout, browser CSP/cookie behavior, keyboard/mobile/accessibility and long-running tab lifecycle still need manual testing. The DOM shim is not a browser certification or full XSS audit. With no `web/node_modules/ws`, root checks still run core/pure UI/auth tests and explicitly skip 15 optional web transport/app/CLI tests; install the pinned package to run them. All tests are free of paid/live model calls.

Still pending: persistent enrollment/secret storage and login maintenance, independent multi-computer connector operation, actual registered-project Pi/container integration with project locks and clean stdio, larger-than-4-MiB native histories, optional server cache interface, production quotas in RPC, real browser automation/verification and broader hardening/review. HTTPS/WSS deployment and Internet exposure are **not supported yet**. Remote Git/apt approvals and a supervisor remain deferred; existing terminal-only host approval and production quota-auto gates are unchanged.
