# Local web control (dummy demo and experimental Pi projects)

A first browser-testable chain is implemented: authenticated loopback HTTP/WebSockets → outbound dummy connectors → local JSONL RPC → bounded text views → browser chat. The default remains token-free dummies. **Experimental locally registered Pi projects are now selectable explicitly with `--project`.** The Pi wrapper/connector path is covered by fake-Podman tests, not yet verified with a real container here. This is not an Internet or independent multi-computer deployment.

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

Password hashes, per-connector keys, browser sessions, conversations and synthetic quota state are **in memory only**. Nothing is saved to project config, PIS_HOME, auth files or a server transcript database. Restarting the demo resets everything and asks for a new temporary password. The CLI does not print machine keys/passwords or persist a registration database. Persistent setup, independently operated connector CLI/enrollment and moving the server between machines remain future work. Real Pi projects differ from the dummy: their normal sandbox session/project state persists in existing pis storage, while web authentication and transport state remain ephemeral.

## Experimental real Pi projects (local host only)

Stop any terminal session already using the intended project first: one project remains exclusive. In a **host terminal**, list existing registrations and select explicitly:

```sh
pis --list
./start_server.sh --project my-app
# Multiple independent registered projects:
./start_server.sh --project my-app --project other-app --port 43129
# With a supported Node selected, equivalent:
npm run web:start -- --project my-app
```

These names/IDs must already exist in the same host `PIS_HOME` as normal `pis`; no project is registered or configuration rewritten automatically. Only projects configured with `agent: "pi"` are accepted. No Claude override, arbitrary executable/path, remote project selection, model/session startup args, mixed dummy/Pi list or remote mount control is supported. Omit `--project` for the dummy demo. `npm run web:demo` deliberately remains dummy-only.

**Real Pi prompts can spend subscription quota or API credits and edit mounted project files.** The host prints a cost warning and the UI labels real Pi agents; dummy-only quota simulation buttons are hidden for them. The connector sends only `get_state` during startup, not an initial prompt; normal configured extensions or restored Pi behavior can independently cause model activity. It continues the latest session using existing Pi defaults. It does not attach to an already running terminal Pi process. Configured model/provider/proxy/mount settings and persisted session state are preserved. The web server receives bounded text views, never the project's provider credentials. Its ephemeral machine registrations are created by the local host, not agent event claims.

The first-party `bin/pis-project-rpc.js` wrapper uses existing `launch()`/Podman image selection, host provider proxy and exclusive project locks. It rechecks the configured agent under lock. Stdio is pipes/RPC without TTY; image build output stays on stderr, not protocol stdout. Credential forwarding restrictions remain unchanged. The new mode adds no host mounts/sockets/agents, bypass flags or remote shell. Git/apt proposal tools and `--auto-wait-codex` remain unavailable in web/RPC; native sandbox tools/ordinary untrusted extension commands still work. Account proxy routing is independent of continuation.

Image build/startup can take minutes; the connector allows up to ten minutes for initial state. On startup failure there is no automatic retry of the local process. Diagnose the project with normal host `pis` and its lock/Podman/config commands. Other project lock holders are refused, not killed/unlocked. The browser disconnect/reconnect never tears down or restarts Pi. To shut down all local web sessions, use Ctrl-C in the launcher terminal; the connector requests clear-queue/abort, closes stdin and allows the wrapper about a minute for termination and independent container removal/existence checks. An unclean wrapper exit is not reported as successful cleanup. If shutdown cannot confirm the container is gone, the **project lock is retained**, even after its wrapper exits: inspect on the host and use the existing conservative `pis --unlock --dry-run` / `pis --unlock` workflow only when safe. Do not delete locks or kill the host launcher just to skip those checks.

Verification is deliberately limited: seven new offline tests use fake Podman and a synthetic native RPC subprocess to exercise registration/config preservation, Claude/config-race rejection, clean build/protocol streams, exclusive locks, unknown-cleanup lock retention, reconnect without a new run, actual web CLI project startup/shutdown and successful final cleanup. They do not execute real Pi or prove production container/proxy lifecycle. A new opt-in `PIS_INTEGRATION=1 node --test test/project-rpc-integration.test.js` exercises real rootless Podman state/history/lock/EOF cleanup with fresh credential-free state and **no model prompt**; it is present but **not run here**. First real-project use should be supervised; full stream/provider/browser lifecycle still needs real-container verification.

## Components and dependency boundary

- `web/server.js`: separate HTTP/WebSocket server, hashed admin authentication, cookie sessions, authenticated agent roster, scoped command routing and live forwarding. No Pi/provider/Git/Podman capability is supplied to this server.
- `web/connector.js`: outward-only network connection wrapping an existing `PiView`; the demo helper spawns **only the fixed first-party dummy executable**; `web/project-connector.js` can instead spawn the fixed first-party registered-project wrapper after explicit local selection. A remote message cannot select an executable, project directory, mount or native RPC method.
- `web/public/`: a static login/roster/chat UI, bounded chat model and text-only renderer. Authoritative final messages replace streamed partials; tools and provider-exposed thinking are displayed only as untrusted text. Native metadata/attachments remain omitted by `PiView`.
- `web/cli.js`: temporary local setup, memory-only random distinct connector keys and a hidden password prompt. It starts two outbound dummy connections by default, or explicitly selected local Pi projects in `start --project` mode.

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

**21 web tests pass** with the optional dependency installed. They use real loopback HTTP/WebSockets and fixed dummy subprocesses, covering authentication/rate limits, Host/Origin/CSRF/cookie/logout/expiry, payload bounds, cross-agent routing/forgery rejection, stale generations, ambiguous deadlines, key revocation, streaming, stop, browser/connector disconnect and same-runtime quota resumption. Pure UI tests cover authoritative final reconciliation, snapshot races, memory bounds and hostile text rendering. One integration test runs the **actual app module in a DOM shim**, exercises login/select/chat/quota/logout through real transports; another starts and shuts down the actual demo CLI, checking that secrets do not appear in output.

Five additional offline launcher tests use fake Node/npm executables to cover compatible PATH/bundled selection, the Node 24 fallback, missing tools/dependencies, paths with spaces, option forwarding and help without downloads. The fallback's exact invocation is tested without making npm downloads in fast checks.

No graphical browser was available here: actual layout, browser CSP/cookie behavior, keyboard/mobile/accessibility and long-running tab lifecycle still need manual testing. The DOM shim is not a browser certification or full XSS audit. With no `web/node_modules/ws`, root checks still run core/pure UI/auth tests and explicitly skip 15 optional web transport/app/CLI tests (plus two optional project-web connector/CLI tests); install the pinned package to run them. All tests are free of paid/live model calls.

Still pending: persistent enrollment/secret storage and login maintenance, independent multi-computer connector operation, real-container validation/hardening of the experimental registered-project connector, larger-than-4-MiB native histories, optional server cache interface, production quotas in RPC, real browser automation/verification and broader hardening/review. HTTPS/WSS deployment and Internet exposure are **not supported yet**. Remote Git/apt approvals and a supervisor remain deferred; existing terminal-only host approval and production quota-auto gates are unchanged.
