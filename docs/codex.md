# OpenAI Codex subscription proxy

`pis` supports Pi's **`openai-codex` provider** using ChatGPT OAuth subscription credentials. Access tokens, refresh tokens, and real account metadata stay in a private host credential store. Pi receives a synthetic JWT-shaped proxy capability, not a usable OpenAI credential.

OpenAI API keys still use the separate `openai` proxy mode described in [proxy.md](proxy.md). A Codex-named API model and a ChatGPT/Codex subscription are different authentication paths.

## Set up

Run these commands in your **host terminal**, not inside Pi or `pis --bash`:

```sh
pis --login-codex
```

Open the displayed `https://auth.openai.com/codex/device` page and enter the short code. Finish sign-in in your browser. No local OAuth callback port or installed host Pi/Codex CLI is required.

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

## Storage, refresh, and sign-out

Credentials live at:

```text
$PIS_HOME/auth/openai-codex.json
# Default: ~/.local/share/pis/auth/openai-codex.json
```

The storage root follows the same `PIS_HOME` / `XDG_DATA_HOME` selection as projects. The directory is 0700; the file is 0600 and owned by your user. It is plaintext sensitive data, not an OS keyring. Do not commit, publish, or expose this directory as a project mount. The existing mount policy forbids sharing pis storage.

There is **one shared Codex sign-in per pis storage root**, reused by every project choosing `openai-codex`. Signing in or importing again changes the account for subsequent requests from those projects. Multi-account named profiles are not implemented.

Before a Codex request, the host checks expiration and refreshes if the access token expires within a minute. Refresh requests go directly to the fixed `https://auth.openai.com/oauth/token` endpoint, with redirects rejected. Rotated credentials are saved atomically on the host. A shared lock serializes refreshes across concurrent projects, and waiting requests re-read the latest token to avoid reusing a rotated refresh token.

Cancellation or refresh failure preserves the previous credential file and releases the refresh lock. Errors do not include token response bodies or secret values. If refresh fails, requests fail closed with a host-authentication error; the wrapper never forwards a real token to the container as a fallback.

```sh
pis --show           # Shows host-oauth presence, not token values or account identity
pis --logout-codex   # Removes the shared host sign-in
```

Sign-out does not revoke tokens at OpenAI, remove imported source files, or cancel already forwarded requests. Future requests need a host sign-in. A crash can leave `auth/openai-codex.lock`; inspect its PID and active pis processes before manually removing a stale lock.

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

Only **POST `/backend-api/codex/responses`** is allowed in Codex mode. Standard `/v1` API routes, OAuth/token endpoints, query strings, redirects, arbitrary destinations, CONNECT, and WebSocket forwarding are not allowed.

The host replaces `Authorization` and derives `chatgpt-account-id` from the current real token; client-supplied account headers cannot choose the billed account. `originator` and the SSE beta header are host-controlled. Only bounded session/request IDs are optionally preserved from client headers.

Codex uses SSE through this proxy. Pi 1.2's automatic WebSocket transport attempt is rejected locally and falls back to SSE; no authenticated WebSocket is forwarded. You can use Pi's `transport: "sse"` setting to skip that attempt. This implementation is not a WebSocket proxy.

Pi running on Node 24 sends zstd-compressed Codex requests. The host accepts bounded zstd input, enforces the decompressed 16 MiB limit before parsing/model checks, then sends uncompressed JSON upstream. Responses are streamed with backpressure and exact access-token redaction; long JWTs do not cause ordinary SSE frames to be buffered until completion.

The existing proxy request count, model allowlist, concurrency, timeout, response-size, header rebuilding, and generic-error policies apply. See [the shared proxy limits](proxy.md#routes-and-limits). Codex model listing uses Pi's catalog; `/v1/models` is not enabled in Codex mode.

## What the container sees

- Per-run dummy `openai-codex` entries in read-only `auth.json` and `models.json` overlays.
- A synthetic JWT with account claim `pis-proxy-account` and a random capability signature. It is not a valid ChatGPT token.
- `PIS_PROXY_TOKEN`, `PIS_PROXY_BASE_URL`, and `PIS_PROXY_PROVIDER=openai-codex` for other sandboxed tools.
- An empty `OPENAI_API_KEY` / `OPENAI_BASE_URL`, avoiding accidentally enabling the API-key provider with the Codex capability.

Original sandbox provider files are unchanged. Other provider entries remain as configured. The host managed credential file, access token, refresh token, and real account ID are not mounted or placed in container launch arguments/environment. Extensions execute inside the container and receive the same dummy-only view.

This does not scrub old secrets from arbitrary project files, logs, sessions, or other provider entries. Do not put real credentials into mounted files, pass them through `--api-key`, or run `/login` inside the sandbox. Anyone with host access as your user remains trusted.

The dummy capability grants permitted subscription usage for the lifetime of its run. Request counts are **not** token/monetary quotas, and container network access is still enabled by default. Stronger general egress restrictions and resource limits remain separate work.

## Verification and compatibility

Tests cover host device flow with mocked responses, explicit imports, private file handling, refresh rotation/concurrency/cancellation, fixed Codex routes, account-header replacement, bounded zstd decoding, dummy JWT compatibility, and token-safe errors/redaction.

The real rootless Podman integration test uses Pi's actual `openai-codex` provider and a local fake OAuth/upstream service, with container networking disabled. It verifies a streamed conversation and an extension seeing only synthetic credentials. API-key proxy and direct-mode integration tests are also retained. No live account sign-in or paid subscription/model requests are performed by tests.

The protocol follows the pinned Pi 1.2 implementation. Live OpenAI device authentication, backend behavior, workspace policy, and future protocol changes still require real-account verification. If OpenAI changes this protocol, update the host integration and pinned Pi compatibility together.

References:

- [OpenAI Codex authentication](https://developers.openai.com/codex/auth/)
- [Pi provider authentication](https://pi.dev/docs/latest/providers)
