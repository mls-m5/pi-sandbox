# Independent local agent registration (first test slice)

Implemented: an empty standalone controller, browser-issued per-agent keys and independently launched local dummy/registered-Pi connectors. **This version is localhost-only and runs as host processes, not a server container.** It does not yet provide a LAN listener, TLS, persistent server registration, inter-agent messaging or remote host approvals. The normal `pis --server` dummy demo and explicit `--project` convenience mode remain available unchanged.

## Laptop test: server and separate agents

Install the optional dependency once in the checkout, as for the existing web demo:

```sh
npm --prefix web ci --ignore-scripts --omit=optional --no-audit --no-fund
```

In a host terminal (not inside a sandbox):

```sh
pis --server --standalone
```

Choose a temporary admin password, or press Enter to generate/display one once in that terminal. Open **http://127.0.0.1:43128** (not `localhost`) and log in. There are initially **no agents**; the server starts no Podman/model processes. In the sidebar expand **Registrera agent**, enter a display name, choose **Pi-projekt** or **Dummy (tokenfri)** and create a key. The key is shown only in that creation response; copy it before clearing the field. It is cleared on logout, browser transport disconnect and page exit and is never put in browser storage or diagnostic lines. Browser extensions/devtools/screenshots can still see a displayed key—treat it as a secret.

### Token-free first check

Choose Dummy in the registration form. In a second host terminal:

```sh
pis --connect register demo-a --server http://127.0.0.1:43128 --dummy
# Paste the newly displayed key at the hidden prompt.
pis --connect run demo-a
```

For another agent, create a **separate** registration/key in the GUI, then in another terminal:

```sh
pis --connect register demo-b --server http://127.0.0.1:43128 --dummy
pis --connect run demo-b
```

Both appear in the roster. The first agent opens automatically; choose another to read its bounded recent history, prompt, observe tools or stop work. Dummy runtimes use no model tokens and hold history only until that dummy process exits. Keep their run terminals open. Ctrl-C in an agent terminal shuts down **that local agent**, not the server or other connectors. Ctrl-C in the standalone server terminal shuts down **only the server**; independent agents/local work can continue.

### Real locally registered Pi projects

Stop any ordinary terminal Pi session already holding that project. In the GUI create a Pi-project registration, then:

```sh
pis --list
pis --connect register laptop-app --server http://127.0.0.1:43128 --project my-app
pis --connect run laptop-app
```

`laptop-app` is a local connector-profile name, independent of the display label and project name. The project must already be registered/configured for Pi on this host. No Claude override, arbitrary path/executable, startup prompt, mounts, provider credentials or native RPC method comes from the server. Registration only verifies the key's server identity/type and saves the host profile; it does **not** start Pi/Podman or send a model request. Run rechecks that identity before launching the existing fixed project RPC wrapper. The same rootless Podman boundary, provider proxy, exclusive project lock, stopped-container verification and lock retention on uncertain cleanup still apply. Startup extensions and later browser prompts can spend quota/credits. Git/apt web approvals and production quota-auto remain unavailable.

Trust the selected controller: it can read the agent's permitted history, send prompts and stop work. Its authority is not limited to passive status observation. Agent-to-server messages remain scoped to their own registered identity/routes; there is no agent-to-agent command/message route. Idle is not task success.

## Ephemeral server, private client profile

The server keeps admin password hashes, session records and at most 32 agent registrations (only **SHA-256 hashes of random 256-bit keys**) in memory. There is no registration database, server secret file, transcript database or persistent volume. It relays live frames and bounded read results and transiently holds command routing/network buffers; this is not a guarantee that chat data never occupies server memory. History snapshots come from connected clients, not a stored server transcript. Real Pi's normal sandbox-local saved sessions persist independently; registration and server restart do not erase them.

Client profiles live at **`$PIS_HOME/web-agents/NAME.json`**, normally `~/.local/share/pis/web-agents/NAME.json`: a private host-only 0700 directory with 0600 files owned by the current user. They hold the loopback server origin, agent ID/key, kind and a local registered project ID (not arbitrary executable/project paths). Symlinks, hardlinks, nonprivate or nonregular/oversized/malformed profile files are rejected. These files are outside the project/shared sandbox state and are never added to project JSON, image build contexts, Podman environment/mounts or RPC/network payloads other than the connector's Authorization header to the validated server. Never mount `PIS_HOME`/host home into the sandbox or commit a profile. Protect host backups as credential-bearing.

### Server restart or revocation

A normal network interruption reconnects with the same identity/key and runtime generation, without replaying prompts or shutting down Pi. Server restarts discard **all** registrations and sessions—even if you choose the same admin password and port. Old agent keys no longer authenticate. On HTTP 401/403 an already-running connector stops automatic authentication retries and warns that its local runtime may still be working; it does not kill local work. Initial real-project startup still requires registration acknowledgement: if registration fails before startup completes, the existing startup-failure cleanup shuts down the just-started wrapper and verifies/retains its project lock as appropriate. Duplicate live identities are refused (409, with ordinary bounded backoff); upgrade throttling uses 429 rather than falsely claiming the key was revoked.

After restart:

1. Stop each old connector locally with Ctrl-C when appropriate; inspect retained project locks if cleanup is uncertain.
2. Log in to the restarted server and create fresh matching registrations/keys.
3. Replace each client profile explicitly, then run it again:

```sh
pis --connect register laptop-app --server http://127.0.0.1:43128 --project my-app --replace
pis --connect run laptop-app
```

To revoke a key without restarting, select its agent in the GUI and click **Återkalla vald agentnyckel**. Confirm the browser question. This removes the registration, invalidates that key, closes its connection and resolves outstanding routes as unknown. It **does not stop local agent work**. Use Stoppa before revocation if desired, or stop on the agent host. The secret cannot be recovered or redisplayed. A lost creation response can leave an offline registration with no known key: revoke it and create a new one, rather than automatically retrying creation.

```sh
pis --connect forget laptop-app
```

Forget deletes only the private local profile. It does not revoke a server key or stop an already-running connector. `register --replace` likewise does not reconfigure an already-running connector; stop/run it explicitly. Do not run two connectors for the same registration; the server refuses concurrent reuse and real projects also retain their exclusive local lock.

## Security and current limits

- Registration/revocation are authenticated **admin-only HTTP POSTs**, exact loopback Host/Origin, JSON/custom-header, session and CSRF checks; agent keys cannot call admin APIs. The display label is bounded plain text, and only Pi/dummy kind is accepted. IDs and keys are server-generated; caller-selected IDs/secrets/extra fields are rejected.
- The machine identity preflight accepts only an agent bearer key, with no browser Origin/cookie. It returns only that key's own ID/kind. The run/registration client uses a five-second no-redirect request and a 1024-byte result limit. Keys are never URL parameters, argv or environment variables. `--key-stdin` is an explicit bounded automation/test input; avoid shell-history-bearing `echo SECRET` commands. Interactive key input is hidden, cancellation writes no profile, and existing profiles require `--replace`.
- The connector and server still use exact role separation, correlated routes/generations, no ambiguous prompt replay, heartbeat/backpressure/frame/body/session/connection limits, authenticated WebSocket upgrades and CSP. Existing [web control security limits](web-control.md#authentication-and-bounds) remain in force.
- The standalone server still runs as your host user. Loopback/authentication are **not OS isolation**. Dedicated least-privilege Podman server isolation and a separate TLS-protected LAN agent listener are next-stage work; do not expose the current HTTP listener through a public proxy or disable certificate checks as a shortcut. Do not mount credentials/projects/Podman sockets into a future controller container.
- The current command accepts **only `http://127.0.0.1:PORT`**. This is intentionally a same-laptop test, not the proposed LAN deployment. No SSH keys on agent machines are required for this test. Browser access to the same loopback origin through an SSH tunnel is still possible, but multi-computer enrollment/TLS is not being claimed.

## Verification

`npm run check` and `npm run test:web` cover authenticated creation/revocation, one-time key display/clearing through the actual app DOM shim, private profile files/hidden input, rejected schemes/paths/roles, server restart invalidation, two independent token-free dummy CLI processes, fetched client history, no automatic replay, and recovery with explicit replacement. A fake-Podman CLI test checks real-project selection/lock/cleanup and that the agent key/profile never enters the container invocation. All use fake upstreams/no live model calls. Graphical browser/mobile layout, actual rootless Podman lifecycle, crash recovery and prolonged multi-agent operation on the laptop still need host verification. TLS/LAN and controller-container behavior are not implemented/tested by these checks.
