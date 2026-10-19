# Host-side API credential proxy

The proxy is implemented and enabled in API-key mode for **new projects**. Existing projects keep their previous credential mode until explicitly edited. OpenAI API keys (`openai`), Berget (`berget`), host-managed OpenAI-compatible custom endpoints (`custom`), and ChatGPT/Codex subscription OAuth (`openai-codex`) are supported. This is not a general-purpose HTTP proxy.

This page primarily describes API-key setup and shared policies. For host Codex sign-in/import/refresh and synthetic JWTs, see [Codex subscription setup](codex.md).

## Enable it

Run `pis --edit` and use this complete `credentials` section:

```json
{
  "credentials": {
    "env": [],
    "proxy": {
      "provider": "openai",
      "keyEnv": "OPENAI_API_KEY",
      "models": [],
      "maxRequests": 1000,
      "maxConcurrent": 4
    }
  }
}
```

This is a configuration fragment; retain the rest of the project configuration.

Set `OPENAI_API_KEY` in the **host terminal**, then run `pis`. To enter a key without putting its value in shell history, Bash users can use:

```sh
read -rsp 'OpenAI API key: ' OPENAI_API_KEY; echo
export OPENAI_API_KEY
pis -- --model openai/<model-id>
```

Replace `<model-id>` with an OpenAI model supported by Pi. The same proxy is available in `pis --bash` and `pis --exec`.

`keyEnv` may name another host variable. Its value is never passed into the container. A missing key stops launch: there is **no fallback** to direct credential forwarding. `pis --build`, `--check`, and `--show` do not require a key. OpenAI and Berget can instead reference a private host profile; a profile always takes precedence and never falls back to an environment key.

`credentials.env` must be empty when proxy mode is enabled, preventing accidentally forwarding the real key alongside the dummy credential. To deliberately use direct credentials instead, remove `proxy` and configure `env`; those credentials will then be visible inside the sandbox.

## Host API-key profiles

Manage host-only API-key profiles explicitly:

```sh
pis --login openai       # fixed OpenAI URL, hidden key prompt
pis --login berget       # Berget URL, hidden key prompt
pis --login custom       # trusted custom endpoint and model setup, then hidden key
pis --login-status       # provider/profile presence only, no values
pis --logout berget      # removes local copy; does not revoke the provider key
```

Profiles live in `$PIS_HOME/auth/` (default `~/.local/share/pis/auth/`), are written atomically with mode 0600 inside a 0700 directory, and are never mounted into the container or included in image builds. Login does not make a paid API request. Cancellation or invalid input does not save a partial profile. `pis --show` and `--login-status` report profile/provider and credential presence only, never key values.

To select a stored Berget profile in a project, set `credentials.env` to `[]` and use `{ "provider": "berget", "profile": "berget" }`. To select the environment-key route instead, use `{ "provider": "berget", "keyEnv": "BERGET_API_KEY" }`. These are mutually exclusive; a missing selected credential fails closed.

`pis --login custom` asks for an HTTPS API base URL ending in `/v1`, confirmation of tool-call support, verified model IDs, published context/output limits, image-input and reasoning capabilities, and a hidden API key. Only OpenAI Chat Completions is supported; no discovery, model-list, or live validation request is made. The custom model catalog belongs to the host profile, not `credentials.proxy.models`. Project config contains only `provider: "custom"` and `profile: "custom"`, never the endpoint or key.

Custom destinations must use HTTPS on port 443, with no URL credentials, query, or fragment, and a safe path prefix ending in `/v1`. IP literals, local hostnames, and DNS results in private/special-use ranges are rejected. DNS answers are resolved and pinned when the host proxy starts; requests use only `/v1/chat/completions` with the configured base path prefix and never follow redirects. Loopback HTTP remains available only to the internal fake-service test seam. This does not constrain container egress generally.

## Architecture

```text
Host pis process (real key in memory)
  └─ Private HTTP server on /tmp/pis-proxy-XXXXXX/api.sock
       ↑ read-only Unix socket directory mount, current UID only
Container
  ├─ Node relay on 127.0.0.1:43127
  ├─ Pi configured for http://127.0.0.1:43127/v1
  └─ Random per-launch dummy/capability key (synthetic JWT in Codex mode)

Request → validate capability, route, model, and limits
        → replace Authorization with the real host key
        → fixed provider upstream or explicit host-profile HTTPS endpoint
Response → stream back without exposing authentication headers
```

There is **no host TCP listener**, published port, host network mode, or requirement to make host localhost reachable through Podman networking. Each launch gets an independent capability, socket, and request budget. The capability is invalid after shutdown.

Only the Unix socket, dummy credentials, and container relay/configuration files are mounted at `/pis/proxy`. The host proxy implementation and real key are not mounted. The selected source key variable, host `OPENAI_API_KEY`, and host `BERGET_API_KEY` are removed from Podman build/run subprocess environments; the runtime gets only dummy values. The runtime directory is private (0700), its files/socket are 0600, and normal shutdown removes it. Forced process death can leave inert runtime files. They do not contain the host proxy credential, but preserved entries for other sandbox providers may contain previously stored secrets, so treat leftover runtime directories as sensitive.

The container entry process starts the relay, launches Pi/Bash/the selected program, forwards signals, and stops the relay when that program exits. The host wrapper stops the proxy after container cleanup.

## Pi configuration

Pi's built-in OpenAI provider is redirected using per-run **read-only file overlays** for:

- `/pis/home/.pi/agent/models.json`
- `/pis/home/.pi/agent/auth.json`

The selected `openai`, `berget`, `custom`, or `openai-codex` provider/auth entries are replaced with the appropriate loopback endpoint and dummy capability. Other provider entries are retained. Original files remain unchanged (empty JSON files are initialized when absent).

Consequences:

- Existing custom declarations, endpoint overrides, and authentication headers for the selected provider are hidden for that launch; Pi uses its built-in catalog through the proxy.
- Other configured providers are not automatically proxied.
- Editing these files or using `/login` to save credentials while the proxy is active will fail because the overlays are read-only. Do not enter real provider credentials inside the sandbox.
- Sessions, extensions, and other Pi state remain persistent and writable as before.
- Symlinked state/configuration paths, non-regular configuration files, and oversized JSON files are rejected. The host must not follow sandbox-created links into unrelated host files.

In API-key mode, tools using standard `OPENAI_API_KEY` / `OPENAI_BASE_URL` variables can use the relay too. All proxy modes also expose dummy-only `PIS_PROXY_TOKEN`, `PIS_PROXY_BASE_URL`, and `PIS_PROXY_PROVIDER`. Codex mode leaves the standard OpenAI API variables empty so it does not accidentally select the API-key provider.

## Routes and limits

Allowed upstream requests:

| Provider mode | Method | Exact path |
| --- | --- | --- |
| `openai` | POST | `/v1/responses` |
| `openai` | POST | `/v1/chat/completions` |
| `openai` | GET | `/v1/models` |
| `berget` | POST | `/v1/chat/completions` |
| `custom` | POST | `/v1/chat/completions` |
| `openai-codex` | POST | `/backend-api/codex/responses` |
| `openai-codex` | GET | `/backend-api/wham/usage` |

Modes are separate: a Codex capability cannot call the standard API routes, or vice versa. Codex routes are fixed to `https://chatgpt.com`; OpenAI routes are fixed to `https://api.openai.com`; Berget routes are fixed to `https://api.berget.ai`. A custom destination is available only through the explicit, private host profile described above.

All other paths, query strings, absolute URLs, HTTP CONNECT, and WebSocket upgrades are rejected. File management, response retrieval/deletion, images, audio, and Decisions/classifier endpoints are not supported yet. Sandbox requests and project JSON cannot select another upstream; only an explicitly managed host profile can configure a custom destination.

The Codex usage endpoint returns only validated numeric quota/reset windows; identity, email, plan metadata, arbitrary fields, and tokens are discarded. It supports the image usage-bar extension through a narrow container-only fetch adapter. Usage polls use the same capability, host refresh, limits, and request budget; no extra real credential is supplied to extensions.

`credentials.proxy.models` is an exact allowlist for POST request model IDs; an empty array allows any model. `/v1/models` is available only in OpenAI mode and is not filtered, so selecting a model outside the allowlist results in a rejection when generating a response. Berget and custom modes use a host-side Pi model catalog; those definitions are separate from the request allowlist.

- `maxRequests`: total upstream attempts per launch, default 1000, configurable 1–100000. Model-list requests, failed upstream attempts, and SDK retries count too.
- `maxConcurrent`: simultaneous accepted requests/uploads, default 4, configurable 1–64.
- Request body limit: 16 MiB; POST bodies must be JSON with a model. Codex zstd requests are decompressed with the same output limit before validation; unsupported request/response encodings fail closed.
- Response limit: 64 MiB.
- Per-request total timeout: five minutes, including streaming; request/header upload timeouts are also bounded.

The proxy rebuilds upstream headers rather than forwarding cookies, client-supplied organization/project/account headers, Host, proxy authorization, or forwarding headers. Berget and custom credentials are treated as opaque printable API keys; the proxy does not assume OpenAI's `sk-` prefix. Codex account identity is derived from the current real host token, never a client header. Redirects are never followed. Upstream non-success bodies and headers are not exposed; errors report a generic status instead. Successful SSE/JSON responses stream with backpressure, with exact occurrences of the real key redacted even across chunk boundaries.

The proxy logs no request bodies, headers, credentials, or upstream URLs. It deliberately provides less detailed error information than a direct upstream connection.

## Security boundaries and limitations

This hides the **host-provided API key or Codex OAuth tokens**, not the ability to use them:

- Pi, extensions, and any sandboxed process can read the dummy capability and make permitted API calls while the run is active.
- Request counts are not a monetary/token quota. Use OpenAI-side budgets, restricted keys, and the model allowlist for stronger spending controls.
- Container egress remains enabled. This is not a general host/LAN firewall, prompt exfiltration defense, or VM boundary.
- Host processes running under your account remain trusted and can inspect the wrapper's environment/memory. The Unix socket permissions isolate other accounts, not malicious processes under your own account.
- This does not retroactively remove secrets from old sessions, arbitrary Pi settings, package state, or project files. Do not put real keys in mounted `.env` files or pass them via Pi's `--api-key` option. Rotate credentials already exposed to an untrusted environment.
- Custom images and build instructions remain trusted executable configuration. Runtime keys are not passed as build arguments.
- SELinux shared socket labeling is implemented but still needs verification on an enforcing host.

## Verification

`npm test` covers capability checking, exact route/model policies, header rebuilding, redirect rejection, generic failures, split-key redaction, limits, timeouts, cancellation, configuration validation, and state symlink/FIFO defenses.

`npm run test:integration` additionally exercises real rootless Podman, the mounted Unix socket, dummy-only credentials, read-only Pi configuration overlays, actual Pi API-key and Codex streamed conversations, host OAuth refresh, and extensions observing only dummy capabilities. The Codex test runs with container networking disabled and verifies the baked web-search package through an actual Pi tool call, plus quota retrieval without identity/token metadata. The upstream is a local fake OpenAI service with fake credentials. No paid API requests are made.
