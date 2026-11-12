# OpenAI Codex subscription proxy

`pis` supports Pi's **`openai-codex` provider** using ChatGPT OAuth subscription credentials. Access tokens, refresh tokens, and real account metadata stay in a private host credential store. Pi receives a synthetic JWT-shaped proxy capability, not a usable OpenAI credential.

OpenAI API keys still use the separate `openai` proxy mode described in [proxy.md](proxy.md). A Codex-named API model and a ChatGPT/Codex subscription are different authentication paths.

## Set up

New projects use the `openai-codex` proxy by default. Pi also starts with `--tui-mode regular` unless you pass another TUI mode. Run these commands in your **host terminal**, not inside Pi or `pis --bash`:

```sh
pis --login-codex
```

The command immediately prints `https://auth.openai.com/codex/device` on its own line, then requests and prints your sign-in code. It does not launch a browser automatically. Open that URL manually, enter the displayed code, and finish sign-in in your browser. No local OAuth callback port or installed host Pi/Codex CLI is required.

Then run `pis --edit` in the registered project and replace its `credentials` section with:

```json
{
  "credentials": {
    "env": [],
    "proxy": {
      "provider": "openai-codex",
      "models": [],
      "maxRequests": 1000,
      "maxConcurrent": 4
    }
  }
}
```

Retain the rest of your project configuration. **Remove `keyEnv`** when switching from the API-key proxy: Codex mode uses host OAuth storage, not `OPENAI_API_KEY`.

Find the models in the pinned Pi catalog and choose one available to your subscription:

```sh
pis -- --list-models
pis -- --model openai-codex/<model-id>
```

Replace `<model-id>` with a listed model ID. In Pi, you can also use `/model` and save a default. An older continued session may restore a different provider, so select Codex explicitly when switching an existing project.

A model appearing in the catalog does not guarantee that your subscription/workspace can access it. Subscription limits and OpenAI policies still apply.

### Import an existing host sign-in

Instead of signing in again, explicitly import a file from host Pi or the Codex CLI:

```sh
pis --import-codex ~/.pi/agent/auth.json
# OR
pis --import-codex ~/.codex/auth.json
```

Supported inputs:

- A Pi `openai-codex` OAuth entry.
- A Pi `openai` OAuth entry containing the compatible ChatGPT JWT/refresh credential.
- Codex CLI file-based `tokens.access_token` / `tokens.refresh_token` credentials.

Only the relevant access/refresh/expiry/account fields are copied. API keys, credential shell commands, unrelated providers, and ID tokens are not imported. The source file is read, never mounted into the container or modified.

**Prefer a dedicated `pis --login-codex` session.** Imported refresh tokens rotate; the original client and `pis` must not independently refresh the same copied session. The original file is not kept synchronized and the other client may need to sign in again. Keyring-only or ephemeral Codex sessions cannot be imported through a JSON file.

Device login must be enabled/allowed by your OpenAI account or workspace. If it is unavailable, use a supported host browser sign-in in Pi/Codex and explicitly import its file, or enable device-code login according to your organization's policy.

## Multiple accounts and live selection

The existing shared login remains usable as profile **`default`**, without copying or re-authenticating it. On the host:

```sh
pis --codex-accounts                         # aliases, selected profile, automatic pool
pis --login-codex --codex-account spare       # sign into a DIFFERENT authorized account
pis --codex-use spare                        # subsequent requests use this profile
pis --codex-use default                      # select the original login again
pis --codex-usage --codex-account spare       # quota for one profile; does not switch
pis --logout-codex --codex-account spare      # remove only this local login
```

Use another browser session/private window if the device page otherwise chooses your first account again. A duplicate real identity under another alias is rejected; aliases do not create additional quota. Identity binds workspace/account ID and the JWT user subject when available, so distinct users sharing a workspace are not mistaken for the same login. These fields/fingerprints are not shown in status output. Fresh installations can name their first login with `--login-codex --codex-account primary`; the first saved profile is selected automatically. Later additions do not change the selection.

Without `--codex-account`, login/import/logout/usage address the **selected profile**. Import also accepts the selector. Reauthentication updates only that alias. To rename an existing login without copying a rotating refresh token or signing in again:

```sh
pis --codex-rename primary --codex-account default
```

Rename follows the same credential identity into the selection/pool. `--codex-account` is a management selector, not a per-project launch flag. Selection is **global for all Codex projects in this PIS_HOME**, including already-running proxies loaded with this implementation. In-flight requests keep their original account; new requests read the current selection. Dummy capabilities, Pi processes, sessions and read-only provider overlays do not need replacement. An old wrapper process must be restarted once at a convenient boundary to load this new host code; this does not hot-patch a pre-upgrade proxy.

`--codex-accounts` / `--login-status` print aliases and local presence/shape checks, not real account IDs, emails or tokens. `credentialValid` is a local format/permission check, not an online authentication guarantee. Removing the selected login leaves it selected but missing: choose another explicitly; logout does not silently spend a different account's quota. Renaming can fail closed if interrupted between its file/policy writes; list profiles and use `--codex-use NEW` to recover, then explicitly reconfigure the pool if needed.

### Optional automatic quota failover

```sh
pis --codex-auto-switch default,spare  # explicit ordered pool; active profile must belong
pis --codex-auto-switch off           # disable routing; leave current profile selected
# Convenience: explicitly enroll ALL currently saved profiles (2–16):
pis --codex-auto-switch on
```

Automatic mode is **off by default**. `on` snapshots the profiles present then; newly added profiles never join automatically. Only enroll accounts/workspaces authorized to receive **the same project, prompts, history and tool results**. This is not per-project account isolation. Keep unrelated contexts in separate PIS_HOME stores instead. Replacing an alias with a different real account removes it from the pool; removing a member disables automatic mode if fewer than two remain. Selecting an account outside the pool makes it manual until selecting a pool member again.

Before forwarding a model POST, an enrolled proxy checks subscription usage on the host (60-second overall automatic-routing deadline; positive/exhausted evidence cached up to 60 seconds per credential, with short failure backoff). It switches only when a window is at 100% or `limit_reached` is true, and a subsequent enrolled account has recently verified usable quota. Both returned windows and denial flags gate the candidate; missing/malformed windows, active-account authentication/network errors and non-quota denials never authorize rotation. Failed candidates are skipped, not treated as available. The chosen account stays active until exhausted or manually changed; there is no round-robin or eager return to the first account.

A host-side alias-only notice reports automatic changes; it is not a model/user continuation prompt. Selection commits check the current policy revision and target credential under the shared auth lock. Manual selection, pool withdrawal, logout and cancellation invalidate stale automatic decisions. Each forwarded request retains its own credential/header/redactor for its entire stream. Project route/model/request/concurrency budgets remain shared across the pool and are not reset by switching. No OpenAI API-key fallback is involved.

An upstream HTTP 429 only invalidates quota evidence; it does **not** immediately switch or replay the request. A later request must confirm exhaustion via the fixed usage API. Ordinary rate limiting, 401/403 responses, network failures and arbitrary model text do not cause rotation. If the whole pool has no verified available account, the proxy returns a generic quota error without forwarding a model request.

This is **request routing**, not automatic replay of a partially streamed turn/tool. Native client retries may issue a later request. For an exhausted turn that has already stopped, `--auto-wait-codex` can confirm exhaustion and resume the same settled Pi session using a verified available pool member; startup `--wait-codex` also considers the pool. If no pool member is available they keep normal polling behavior. Plain `--codex-usage` and the GNOME indicator report only the selected/explicit account and never rotate it. A cache/remote-quota race can still allow a request to hit a limit; availability is not a reservation. A pool member may lack the selected model even with quota: model/permission errors require an explicit decision, not model/provider substitution.

Automatic movement is refused with HTTP 409 when a request needs account-bound remote history (`previous_response_id`, `conversation` or `conversation_id`); the proxy never strips these fields or fabricates missing context. Do not use a global automatic pool for clients depending on account-bound server state: another project/manual switch may also change the selected account. Pi 1.5's SSE path was tested sending full context across a host account switch in one actual CLI tool turn, but arbitrary clients/server-state schemes are not certified.

## Storage, refresh, and sign-out

Credentials live at:

```text
$PIS_HOME/auth/openai-codex.json               # legacy/default credential
$PIS_HOME/auth/openai-codex-account-NAME.json  # named credential
$PIS_HOME/auth/openai-codex-accounts.json      # active alias, explicit pool, revision
# Default PIS_HOME: ~/.local/share/pis
```

The storage root follows the same `PIS_HOME` / `XDG_DATA_HOME` selection as projects. The directory is 0700; the file is 0600 and owned by your user. It is plaintext sensitive data, not an OS keyring. Do not commit, publish, or expose this directory as a project mount. The existing mount policy forbids sharing pis storage.

There is one **selected profile per pis storage root**, with up to 32 stored profiles and at most 16 distinct real accounts in an automatic pool. All aliases/settings and credentials stay on the host. No user/project choice is migrated to another provider or real account implicitly.

Before a Codex request, the host checks expiration and refreshes if the access token expires within a minute. Refresh requests go directly to the fixed `https://auth.openai.com/oauth/token` endpoint, with redirects rejected. Rotated credentials are saved atomically on the host. A shared lock serializes refresh/account mutations across concurrent projects, and waiting refreshes re-read the same captured alias to avoid reusing a rotated refresh token or writing it into a newly selected profile. An unexpected refresh account-identity change is rejected; explicitly reauthenticate instead.

Cancellation or refresh failure preserves the previous credential file and releases the refresh lock. Errors do not include token response bodies or secret values. If refresh fails, requests fail closed with a host-authentication error; the wrapper never forwards a real token to the container as a fallback.

```sh
pis --show           # Shows host-oauth presence, not token values or account identity
pis --logout-codex   # Removes only the selected local host profile
```

Sign-out does not revoke tokens at OpenAI, remove imported source files, or cancel requests already being processed/forwarded. Other saved profiles remain. A crash can leave `auth/openai-codex.lock`: `pis --unlock --dry-run` / `pis --unlock` conservatively recover proven-dead host auth-lock owners without reading credentials or requiring Podman, even while unrelated project containers run. No live/unknown owner is stolen. Unlocking cannot recover a refresh token lost after remote rotation; reauthentication may still be needed.

## Request path and policy

```text
Container Pi openai-codex provider
  → http://127.0.0.1:43127/backend-api/codex/responses
  → container-local relay
  → private mounted Unix socket
  → host capability/route/model/limit checks
  → host refresh if required
  → https://chatgpt.com/backend-api/codex/responses
```

Codex mode allows **POST `/backend-api/codex/responses`** and **GET `/backend-api/wham/usage`**. The usage response is reduced to numeric primary/secondary quota and reset windows plus optional boolean `allowed`/`limit_reached` flags; account, email, plan, and credential fields are not returned. Standard `/v1` API routes, OAuth/token endpoints, query strings, redirects, arbitrary destinations, CONNECT, and WebSocket forwarding are not allowed.

The host replaces `Authorization` and derives `chatgpt-account-id` from the current real token; client-supplied account headers cannot choose the billed account. `originator` and the SSE beta header are host-controlled. Only bounded session/request IDs are optionally preserved from client headers.

Codex uses SSE through this proxy. Pi 1.5's automatic WebSocket transport attempt is rejected locally and falls back to SSE; no authenticated WebSocket is forwarded. You can use Pi's `transport: "sse"` setting to skip that attempt. This implementation is not a WebSocket proxy.

Pi running on Node 24 sends zstd-compressed Codex requests. The host accepts bounded zstd input, enforces the decompressed 16 MiB limit before parsing/model checks, then sends uncompressed JSON upstream. Responses are streamed with backpressure and exact access-token redaction; long JWTs do not cause ordinary SSE frames to be buffered until completion.

The existing proxy request count, model allowlist, concurrency, timeout, response-size, header rebuilding, and generic-error policies apply. See [the shared proxy limits](proxy.md#routes-and-limits). Codex model listing uses Pi's catalog; `/v1/models` is not enabled in Codex mode.

## What the container sees

- Per-run dummy `openai-codex` entries in read-only `auth.json` and `models.json` overlays. The model base URL is the full local Codex Responses URL for web-search provider reuse. The auth entry stays `api_key` but also exposes synthetic `access`/account fields for read-only usage extensions; no real OAuth fields are copied.
- A synthetic JWT with account claim `pis-proxy-account` and a random capability signature. It is not a valid ChatGPT token.
- `PIS_PROXY_TOKEN`, `PIS_PROXY_BASE_URL`, and `PIS_PROXY_PROVIDER=openai-codex` for other sandboxed tools.
- An empty `OPENAI_API_KEY` / `OPENAI_BASE_URL`, avoiding accidentally enabling the API-key provider with the Codex capability.

Original sandbox provider files are unchanged. Other provider entries remain as configured. The host managed credential file, access token, refresh token, and real account ID are not mounted or placed in container launch arguments/environment. Extensions execute inside the container and receive the same dummy-only view.

This does not scrub old secrets from arbitrary project files, logs, sessions, or other provider entries. Do not put real credentials into mounted files, pass them through `--api-key`, or run `/login` inside the sandbox. Anyone with host access as your user remains trusted.

The dummy capability grants permitted subscription usage for the lifetime of its run. Request counts are **not** token/monetary quotas, and container network access is still enabled by default. Stronger general egress restrictions and resource limits remain separate work.

## Waiting for quota

`pis --wait-codex` is an opt-in host startup gate: poll usage before creating a container, then resume the latest saved Pi session with a fixed English continuation prompt (uses tokens). It requires a Codex-proxy project and a saved session. For automatic detection during a terminal Pi run, use `pis --auto-wait-codex`: an image-owned extension detects quota-like failures after Pi settles, the host confirms exhaustion, and the same session/branch continues after fresh usage reports quota again. This does not change providers, replay the original task, guarantee the next request succeeds, or bypass permissions/host approvals. Escape, new input or session/model changes cancel a pending continuation. Print/JSON/RPC are unsupported. Ctrl-C cancels. Usage/auth/network failures prevent startup. See [poll timing, locking and session limitations](codex-wait.md).

## Verification and compatibility

Tests cover host device flow with mocked responses, named imports/logins/rename/logout, private file handling, captured-alias refresh and identity checks, explicit pool membership, live proxy selection, quota-confirmed failover/backoff, cancellation/manual-change races, shared budgets, stateful-request refusal, fixed routes, bounded zstd decoding, dummy JWT compatibility and token-safe output/redaction. All quota/OAuth/model services in these tests are fake; no real accounts are logged in, rotated or logged out.

The real rootless Podman integration test uses Pi's actual `openai-codex` provider and a local fake OAuth/upstream service, with container networking disabled. It builds the default `pi-web-access` npm package and verifies a streamed conversation, a real `pi-web-access` tool call, sanitized quota retrieval via the usage adapter, and extensions seeing only synthetic credentials. API-key proxy and credential-free integration tests are also retained. No live account sign-in or paid subscription/model requests are performed by tests.

The protocol follows the pinned Pi 1.5 implementation. Its device-code endpoints/client ID and dummy-token claim expectations were checked against that package, and its real CLI completed a local fake-upstream tool turn across two host credential profiles with one unchanged dummy capability, full request context and settlement hooks. Pi 1.5's Codex catalogue removed some older models; user-selected models and allowlists are not silently rewritten. Live OpenAI device authentication, backend behavior, workspace policy, and future protocol changes still require real-account verification. If OpenAI changes this protocol, update the host integration and pinned Pi compatibility together.

References:

- [OpenAI Codex authentication](https://developers.openai.com/codex/auth/)
- [Pi provider authentication](https://pi.dev/docs/latest/providers)
