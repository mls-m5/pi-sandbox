# Independent agents: simple local connection

Implemented: a standalone controller, client-requested two-digit confirmation, a private host-global server preference, and independently launched local dummy/registered-Pi connectors. **Loopback HTTP host processes, not a server container.** Explicit `ssh://` client forwarding supports an experimental encrypted path to a separately reachable SSH host without exposing HTTP. Direct LAN/TLS deployment, persistent server registration, inter-agent messaging and remote host approvals remain future work; real OpenSSH/multi-computer operation still needs host verification.

## Start the controller

Install the optional web dependency once in this checkout if needed:

```sh
npm --prefix web ci --ignore-scripts --omit=optional --no-audit --no-fund
pis --server --standalone
```

Use a host terminal, not a sandbox. Enter an admin password (or press Enter to generate/display one once), then open **http://127.0.0.1:43128**, not `localhost`. The standalone controller starts no runtimes. The all-in-one dummy demo and explicit `--project` convenience mode remain available.

## Save a server once, then connect from the project

```sh
pis --connect --set-server http://127.0.0.1:43128
cd /path/to/registered/project
pis --connect
```

`--set-server` writes only a host-private default address shared across this client's projects; it starts no enrollment, runtime or model. The address is stored in `$PIS_HOME/web-client.json`. An explicit `--server ADDRESS` overrides it **for that invocation only** and never silently replaces the preference. If no default exists, interactive `pis --connect` asks for an address, validates it and saves it; noninteractive use gets fixed guidance to supply/save one. Direct HTTP still permits only `http://127.0.0.1:PORT`; remote connections must explicitly use SSH, not public HTTP.

Without a name or `--project`, the CLI uses the registered Pi project containing the current working directory (the nearest registered root, including when inside a subdirectory), using normal canonical local selection. It derives a private connection-profile name `p-PROJECT_ID`. An unregistered directory fails with guidance; the CLI never auto-registers a project or accepts project paths/executables from the server. Claude-configured projects are refused.

The client prints a short-lived **two-digit code**. On the authenticated server page, find **Väntande klienter**, select the matching labelled request and enter the code from that client. Check the request identity as well as the label: labels are untrusted and may collide. The server never shows the expected code. The code confirms the intended request; it is not an admin password or the connection credential.

After approval the client collects a distinct random connection key once, saves its private profile and starts the connector. Before collection there is no agent placeholder, runtime, project prompt or model call. For real Pi projects later startup/extensions and prompts may cost tokens. Trust the server as a controller: it can read permitted history, prompt and stop agent work.

## SSH forwarding to another host (experimental)

Save the destination once; you do not need to remember either default port:

```sh
pis --connect --set-server ssh://192.0.2.10
# Or specify the SSH login user:
pis --connect --set-server ssh://alice@server.example
# Then, from a registered project:
pis --connect
```

SSH port defaults to **22**, and the remote pis loopback port defaults to **43128**. Omit the user to use the client's normal SSH login name. Override either port only when needed:

```sh
pis --connect --server ssh://alice@server.example:2222/43129
```

The SSH host must run `pis --server --standalone` bound to its normal `127.0.0.1:PIS_PORT`. The connector remains on the **client host**: its Pi/Podman project, credentials and project locks are not moved to the server. `--set-server` saves only an address, opening no tunnel. Plain connect still asks for an address if none is saved.

Install OpenSSH on the client host and establish key-based login plus an independently verified known-host entry first (`ssh -p SSH_PORT USER@HOST`, checking the fingerprint through a trusted channel). Automatic tunnels require `BatchMode=yes` and `StrictHostKeyChecking=yes`: no password prompts, auto-acceptance of unknown/changed keys or credential capture. The host's default identity files/SSH agent remain usable, but `~/.ssh/config` is deliberately not loaded: aliases, ProxyCommand/ProxyJump and custom identities from it are not supported by this first version. Specify a real reachable host and port. A public web domain works only if SSH is separately reachable there; a CDN/HTTPS reverse proxy is not automatically an SSH endpoint.

Each connector owns one `ssh -N -L` process for enrollment/preflight/runtime. Forwarding listens on a private Unix socket in a 0700 temporary directory, not a public or guessed local TCP port. HTTP/WS continue to use the remote server's canonical loopback origin over that socket, so exact Host/Origin gates remain unchanged. The saved private profile retains only the SSH destination and machine credential, never a temporary port/socket. `run PROFILE` reopens its own tunnel; different clients can connect simultaneously without TCP port clashes. No host keys, SSH agents or host home directories are mounted into Pi containers.

Shutdown/failure/cancellation closes the owned tunnel and removes its temporary socket when process exit is confirmed. No raw SSH stderr is logged. If the tunnel dies during existing work, local runtime work is not silently replayed or reenrolled; the existing connector sees a disconnect. Stop it explicitly and reconnect after resolving SSH. There is no automatic tunnel replacement, password login, autossh daemon, public HTTP/TLS listener or agent-to-agent bridge. Browser/admin access is separate: open the UI on the server host or use your own verified SSH browser-port forward; this command forwards the connector only.

Tests use a fake SSH executable and actual private socket relay, HTTP/WS, pairing and dummy CLI processes. They cover argument validation, strict-key options, one-tunnel lifecycle, scope checks, private profiles and shutdown cleanup. **Actual OpenSSH host-key/authentication behavior and two-computer deployment were not tested in this sandbox (SSH executable unavailable).** Do not interpret these tests as production deployment certification.

### Overrides and token-free check

```sh
pis --connect alias --project PROJECT_ID_OR_NAME --server http://127.0.0.1:43128
pis --connect demo-a --dummy
# Enter each client's displayed code in the server UI.
```

With an explicit profile name and no `--project`, project selection tries that registered ID/name, then a unique final folder component. An ambiguous folder name fails rather than guessing. Profile names retain safe name rules (maximum 64 characters). Advanced `register`, `run`, `forget` are reserved command words; use an alias and `--project` for projects with those names or spaces. `--project` always overrides current-directory/name selection. Explicit `--dummy` selects a token-free dummy; unnamed dummy mode uses the profile `dummy`.

A local project-lock preflight happens **before** requesting approval. Normal locked launch remains authoritative against later races. No existing runtime or live identity is stopped/stolen by connection or profile replacement. If startup fails after successful registration, an offline GUI post may exist; correct the host problem and use `pis --connect run PROFILE`, not blind enrollment retries.

## Approval, expiry and identity contracts

- Requests expire after at most **two minutes**. Active requests have distinct randomly selected two-digit codes to reduce accidental request mix-ups. Creation is limited to 10/minute/server and at most 32 pending/unclaimed requests. No placeholder registration is created merely by requesting or approving a client.
- Machine request/collection endpoints reject browser Origin/cookies. Creation accepts only strict bounded enrollment metadata; collection requires the exact opaque request ID plus a separate 256-bit bearer capability. The code is never sufficient for collection or agent authentication.
- Approval requires an authenticated admin session, exact Host/Origin, JSON/custom headers and CSRF. Budgets are 3 wrong code checks/request, 5 attempts/session/minute and 10/server/minute, including unknown request IDs/malformed approval bodies. Approved requests are bound to the approving session; its logout/expiry invalidates unclaimed approvals.
- Pending browser snapshots contain only request ID, label, kind and expiry. Code/capability/prior-proof values are excluded by construction; the server retains hashes, not the previous bearer proof. UI code inputs clear on submission, snapshot replacement, disconnect, logout and page exit, and are never placed in browser storage/history/diagnostics. The generated two-digit code is intentionally displayed in the requesting client terminal; never share complete terminal recordings containing other secrets.
- Approval and collection recheck state after asynchronous body parsing. Final proof/live checks, consumption and key issuance are synchronous: simultaneous claims yield at most one key. The final plaintext connection key is not retained for replay.
- Offline identity reuse requires the stable local client ID and proof of the previous connection key, with matching kind. Legacy direct registrations can be adopted with their previous key. IDs, display names and approval alone cannot take over an identity. A live identity cannot be evicted, even if an administrator approved a new request; revoke/stop explicitly when intended.
- Pairing HTTP reads have a five-second deadline and a 1024-byte response cap with strict UTF-8/JSON/schema validation. Refused/conflict and over-limit bodies are cancelled and reader locks released; cleanup failure cannot replace a bounded error or expose arbitrary details.
- Only an explicit pending (202) result may be polled again, within the original expiry. Network/HTTP/framing errors or ambiguous create/collection results stop the CLI; it never automatically recreates a request or replays a mutation. Cancellation stops waiting without starting an agent; any orphan request expires. Lost final response/local save can leave a registration without a usable new key: inspect and revoke that exact GUI post, then start a fresh request. The old profile is not replaced on failed collection. HTTP and local disk do not form a distributed transaction.

## Memory-only server and private client files

The server keeps password hashes, sessions, pending request hashes/expiry and at most 32 registrations (hashed 256-bit machine keys) **in memory**. It has no transcript database or persistent enrollment volume. History is fetched from connected clients; transient routing/network buffers can contain sensitive conversations. Real Pi's saved project sessions persist independently.

Profiles live at `$PIS_HOME/web-agents/NAME.json` in a 0700 host-only directory with 0600 regular singly-linked owned files. They contain origin, connection key/agent ID, optional stable client ID and local project ID/kind; never the two-digit code or temporary polling capability. The separate `$PIS_HOME/web-client.json` stores only the default local/SSH server address (under its legacy `origin` field). Unsafe symlinks/hardlinks/nonregular/nonprivate/oversized/malformed files are rejected; writes are locked/atomic. Concurrent explicit setters fail fast on lock contention (`PIS_LOCKED`) rather than queue or retry; the winning file stays complete/private and its lock is released for a later explicit save. The global filename cannot collide with valid agent-profile names.

These files stay outside shared project/sandbox mounts, image builds, project JSON and diagnostics. No host home, provider credentials, SSH agents or engine sockets are added. The connector sends machine keys only in Authorization headers to the validated loopback server, directly or through the authenticated SSH socket transport. Server role separation, correlation/generation/backpressure limits, strict framing and no prompt replay remain unchanged.

## Reconnect, restart, stop and revoke

Ordinary transport interruptions reconnect using the saved connection key and same runtime generation without stopping Pi or replaying prompts. HTTP 401/403 stops retries of that old key while local work may continue. Concurrent active identities receive 409; throttling receives 429. Runtime launch still needs initial registration acknowledgement and normal cleanup/lock verification.

Server restart discards pending requests, registrations and sessions. Log into the new server and use `pis --connect` with a fresh displayed code; the private address preference remains, but is not an enrollment approval. Successful profile replacement never kills an old connector/project. Existing project locks and live-identity checks still apply.

- Ctrl-C during approval waiting cancels that wait; during a running connector it stops **that local agent**, with normal cleanup checks.
- Ctrl-C in the standalone server stops **only the server**, not independently running agents.
- **Återkalla vald agentnyckel** removes the registration/disconnects transport, not local work. Stop agent work explicitly when desired. Unconfirmed command outcomes remain unknown, never automatically replayed.
- `pis --connect run PROFILE` starts a previously saved profile if the server still recognizes it.
- `pis --connect forget PROFILE` removes only that local profile, not registrations, running processes or the global server preference.

## Advanced legacy key compatibility

The GUI's advanced section can still create one-use enrollment keys (10-minute expiry, one unused key per browser session, invalidated on issuer logout). They authorize one exchange for a different connection key, cannot authenticate directly as an agent, and do not pre-create agent posts.

```sh
pis --connect NAME --server http://127.0.0.1:43128 --enrollment-key
# hidden key prompt; --key-stdin is the explicit piped alternative
pis --connect register NAME --server http://127.0.0.1:43128 --dummy
# legacy direct key from admin POST /agents, not a one-use enrollment key
```

Advanced `register` verifies/saves a direct registration without starting a runtime. It requires `--replace` to replace an existing profile. Short connect replaces its profile only after successful enrollment. Neither changes other running clients. Never place keys in argv, URLs, environment variables, project JSON or terminal history.

## Verification boundaries and remaining deployment work

Offline tests use temporary synthetic files, local HTTP/WS, separate dummy CLI processes and fake project services, with no paid/live model calls. They cover request/proof/role/expiry/budget bounds, session revalidation during delayed bodies, simultaneous claims, pending/result ambiguity, unsafe preference files, current-directory selection and overrides, live-identity refusal/profile preservation, and actual app-module code approval/clearing in a DOM shim. Existing one-use-key and real project fake-Podman tests remain gates. A DOM shim is not graphical/browser CSP/accessibility/mobile verification; real rootless Podman and foreground/background subagents remain separate host gates.

**Not implemented:** direct LAN/global-IP HTTP listeners, TLS/WSS deployment, persistent server registration/login maintenance, least-privilege server OS isolation or remote host approvals. Explicit SSH forwarding is the experimental transport for remote connectors; actual multi-computer/SSH host validation remains outstanding. Do not expose current HTTP publicly, disable certificate checks or weaken role/proof protections to approximate them. Idle remains not task success; production quota-auto and host Git/apt approval contracts are unchanged.
