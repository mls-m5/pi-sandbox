# Independent agents: one-command local connection

Implemented: a standalone controller, GUI-issued one-use enrollment keys and independently launched local dummy/registered-Pi connectors. **Localhost-only host processes, not a server container.** LAN/TLS, multi-computer deployment, persistent server registration, inter-agent messaging and remote host approvals remain future work.

## Start the controller

Install the optional web dependency once in this checkout if needed:

```sh
npm --prefix web ci --ignore-scripts --omit=optional --no-audit --no-fund
pis --server --standalone
```

Use a host terminal, not a sandbox. Enter an admin password (or press Enter to generate/display one once), then open **http://127.0.0.1:43128**, not `localhost`. The controller initially has no agents and starts no Pi/Podman/model processes. The default all-in-one `pis --server` dummy demo and explicit `--project` convenience mode still exist.

## One command per agent

In the sidebar, expand **Anslut ny agent** and click **Skapa anslutningsnyckel**. No name or agent type is required. Copy the displayed key and, in another host terminal, run:

```sh
pis --connect pi-sandbox --server http://127.0.0.1:43128
# Paste the key at the hidden prompt; registration and agent startup follow.
```

Here `pi-sandbox` is both the local connection-profile name and default project selector. Selection tries an exact registered project ID/name first, then the **last folder component** of registered roots. An ambiguous folder name fails with a request for a unique `--project ID_OR_NAME`; it never guesses or registers an arbitrary directory. A folder must already be registered with pis. Registered ID/name matches take precedence over folder fallback.

To use a different profile name or disambiguate:

```sh
pis --list
pis --connect laptop-app --server http://127.0.0.1:43128 --project PROJECT_ID_OR_NAME
```

Profile names retain the existing safe name rules (letters/digits, dots, underscores, hyphens, maximum 64 characters). `register`, `run`, `forget` are advanced-command words; use a different profile alias plus `--project` for projects with those names, spaces or longer folder names. The project is resolved locally; the server supplies no project path, executable or startup prompt. Only configured Pi projects are accepted, not Claude overrides.

The command exchanges the one-use key for a **different** random long-lived connection key, saves a private local profile, and starts the connector immediately. No separate `run` or `--replace` is needed. Failed enrollment leaves the previous local profile unchanged. A successful enrollment replaces that profile automatically, but does **not** terminate any old connector/project: existing project locks and concurrent-identity protection still apply. A local project-lock preflight avoids consuming a key for already locked projects; the normal locked launch remains authoritative against races. If startup fails after enrollment, the GUI can show an offline agent; retry `pis --connect run NAME` after correcting the local cause rather than creating another registration.

### Token-free first check

Create a new GUI key for each dummy:

```sh
pis --connect demo-a --server http://127.0.0.1:43128 --dummy
# another GUI key, another terminal:
pis --connect demo-b --server http://127.0.0.1:43128 --dummy
```

No model tokens are used by dummy runtimes. Their history exists only until that process exits. Keep run terminals open. For real Pi projects startup extensions and later browser prompts can cost quota/credits; existing rootless Podman, provider proxies, separate project state, exclusive project locks and verified cleanup/lock retention are preserved. No Git/apt web approvals or production quota-auto is enabled.

## GUI naming, reuse and key lifetime

- An unused enrollment key creates **no placeholder agent**. The GUI clears the displayed key when the server reports it consumed/replaced/expired, on the local ten-minute display deadline, logout, transport disconnect or page exit. Never store it in browser storage or share screenshots/devtools/terminal recordings containing it.
- Keys expire after **ten minutes**, authorize one enrollment and cannot be used directly on `/agent` or `/agent/identity`. Issuing a new key replaces the same browser session's previous unused key. Logout invalidates that session's pending key. Hiding the text alone does not revoke a copied key; it expires or can be superseded by creating a new one.
- After enrollment, the agent appears with its **project folder name**, not the profile alias/old registered display name; dummy labels use the profile name. Names are bounded to 80 characters. If another agent owns the name, suffixes `-2`, `-3`, etc. distinguish it.
- The private profile saves a random stable `clientId`. Re-enrolling the **same offline profile/project/server** proves ownership using its previous connection key and reuses the server agent ID instead of appending duplicate entries. The ID or display name alone cannot authorize takeover. A legacy direct registration can be adopted with proof of its previous connection key. A genuinely different profile/agent gets a separate ID and, if needed, a label suffix.
- A live registration cannot be rotated/evicted by enrollment. Stop your own connector first. Revocation/removal is an explicit admin action; do not revoke another running agent merely to free a name.
- Registration is a mutation and is **never automatically replayed** after an ambiguous result. If the server consumes a ticket but the response/local save is lost, a registration may exist without a usable new local key. Revoke that exact GUI post and create a fresh key; do not weaken proof checks or retry blindly. Profile writes are atomic, but there is no distributed transaction across HTTP and disk.

The controller can read permitted history, prompt the connected agent and stop work: trust it as a controller, not merely a status receiver. Agent messages remain scoped to their own identity/routes, with no inter-agent API. Idle is not task success.

## Requested future simplified connection (not implemented)

The user requested a simpler connection flow for future design/implementation. This section records requirements only; the current GUI-issued one-use enrollment key and `pis --connect NAME --server ORIGIN` behavior above remain unchanged.

- Save a host-global default server address (IP/host and port), shared across the client's projects, in host-private client configuration; allow an explicit server override. A saved address is only a destination preference: it does not approve a server, authorize enrollment, reconnect automatically, or certify LAN deployment.
- Bare `pis --connect` should resolve a locally registered Pi project from the current working directory, without requiring a project/profile name or `--project`. It must not guess when resolution is ambiguous, auto-register a project, or accept a project path supplied by the server. Fail with helpful guidance when no eligible local registration exists or resolution is ambiguous.
- Replace copying a GUI enrollment key with a client-initiated outward request that displays a short-lived two-digit confirmation code at the client. An authenticated administrator UI should list **Pending clients**, allow the administrator to select the exact request and enter the client-displayed code, then approve it. The code confirms the intended client/request; it is not sole authentication or proof of identity.
- Bind approval to an opaque, exact pending request. Define strict expiry, bounded attempts/rates and atomic one-use consumption. Preserve protected machine-key issuance, role separation, prior-key proof for offline identity reuse, and refusal to evict live identities. Never automatically replay an ambiguous enrollment/approval outcome.
- A globally reachable IP/LAN connection requires a separately reviewed TLS/WSS and secure-deployment design. Do not enable public/global binding or treat the current loopback-only HTTP server as LAN-safe. Persistent server-address preference does not imply persistent server enrollment or automatic reconnect approval.

Do not implement this flow by weakening the current ticket/key protections or changing current defaults. Review the existing browser/machine role, origin, session, ticket and ambiguous-outcome contracts before proposing an implementation.

## Memory-only server and private client configuration

The server keeps admin password hashes, sessions, enrollment-key hashes/expiry and at most 32 agent registrations (only hashes of their 256-bit connection keys) **in memory**. It has no persistent secret/registration volume or transcript database. History is fetched from connected clients; routing and network buffers still transiently contain sensitive conversation data. Real Pi's normal saved sessions persist independently and are not deleted by registration/restart.

Profiles live at **`$PIS_HOME/web-agents/NAME.json`**, normally `~/.local/share/pis/web-agents/NAME.json`, in a 0700 host-only directory with 0600 regular singly-linked owned files. They contain the server origin, connection key/agent ID, optional stable client ID and local registered project ID/kind. They do **not** contain the consumed enrollment key. Legacy saved profiles without client IDs can still run and are adopted on the first verified re-enrollment. Symlinks, hardlinks, nonprivate/nonregular/oversized/malformed profiles are rejected.

These files are outside shared project/sandbox state and are never mounted into containers, included in image builds, project JSON, Podman environments or diagnostics. The connector uses its key only in an Authorization header to its validated loopback server. Do not mount host home/PIS_HOME into a sandbox, commit a profile or expose credential-bearing backups.

## Reconnect, restart, stop and revoke

Normal transport interruptions reconnect with the saved connection key and same runtime generation, without replaying prompts or stopping Pi. HTTP 401/403 stops authentication retries for the old key and warns that local work can still continue. Duplicate active identities receive 409; throttling receives 429. Initial project startup still requires registration acknowledgement and performs its normal shutdown/lock verification if that initial registration fails.

A server restart discards all tickets, agent registrations and sessions. To resume: stop old connector terminals locally when appropriate, log into the restarted server, create fresh one-use keys and repeat the same short connect commands. Automatic profile replacement does not change the old running process. A new in-memory server has no old agent records to duplicate. The SSH-admin/LAN-agent two-port design is still future work; current addresses must be `http://127.0.0.1:PORT`.

- Ctrl-C in a connect/run terminal stops **that local agent**, with existing project cleanup checks.
- Ctrl-C in the standalone server stops **only the server**, not independently running local agents.
- **Återkalla vald agentnyckel** removes the selected registration and disconnects it, without killing local work. Use Stoppa before revocation if desired or stop on the agent host. Unconfirmed commands remain unknown, not automatically retried.
- `pis --connect run NAME` restarts a saved local connection without a new ticket if its server registration still exists.
- `pis --connect forget NAME` removes only the host profile, not server registrations or already running processes.
- Advanced legacy `register NAME --server ... (--project ... | --dummy) [--replace]` remains for direct agent keys issued by the older `/agents` admin API. **New GUI enrollment keys are not direct agent keys**; use the short command for them. Legacy register still saves without starting a runtime.

## Security and verification boundary

Admin issuance/revocation require authenticated sessions, exact Host/Origin, JSON/custom headers and CSRF. Machine redemption rejects browser Origin/cookies, validates a strict bounded body, verifies a live issuer session/ticket and atomically consumes the ticket. Duplicate claims race safely; no caller-supplied agent IDs, connection keys, commands or endpoint changes are accepted. Names are plain text and only Pi/dummy kinds are permitted. IDs plus an old bearer proof identify an existing offline agent; arbitrary client IDs cannot rotate someone else's key. Roles, request correlation/generations, backpressure, heartbeat/body/frame/connection caps, no redirect and no prompt replay remain unchanged. Network preflight/redemption have a five-second timeout and 1024-byte response cap; interactive key entry is hidden and `--key-stdin` is explicitly bounded. Never put keys in argv, URLs or environment variables.

This is still a host-user controller, **not OS isolation**. No LAN/TLS listener, server container, persistent server database or inter-agent command route is included. Do not expose the current HTTP listener publicly or disable certificate verification to emulate future LAN support.

Tests cover one-use ticket races/expiry/replacement/logout, no pre-registration placeholders, GUI automatic clearing, collision suffixes, proof-based offline reuse, live refusal, safe local replacement, hidden/private secrets, exact/folder project lookup and ambiguity, automatic dummy/Pi startup, client history and server restart invalidation. Real HTTP/WS and separate dummy CLI processes use no model calls; Pi lifecycle/mount/lock tests use fake Podman. Actual graphical/mobile layout, real rootless Podman lifecycle and prolonged multi-agent/crash operation remain host verification gates.
