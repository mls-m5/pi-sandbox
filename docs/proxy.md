# Host-side model API proxy

New projects default to the Codex subscription proxy. Existing projects keep their previous credential mode until explicitly edited. OpenAI API keys (`openai`), Berget (`berget`), Mistral API keys (`mistral`), host-managed OpenAI-compatible custom endpoints (`custom`), keyless local Ollama (`ollama`), and ChatGPT/Codex subscription OAuth (`openai-codex`) are supported. This is not a general-purpose HTTP proxy.

This page describes API-key/local Ollama setup and shared policies. For host Codex sign-in/import/refresh and synthetic JWTs, see [Codex subscription setup](codex.md).

## Enable it

Run `pis --edit` and use this complete `credentials` section:

```json
{
  "credentials": {
    "env": [],
    "proxy": {
      "provider": "openai",
      "models": [],
      "maxRequests": 1000,
      "maxConcurrent": 4
    }
  }
}
```

This is a configuration fragment; retain the rest of the project configuration.

Log in once on the **host terminal**; the key is entered at a hidden prompt, never in project JSON, argv or shell history:

```sh
pis --login openai
pis -- --model openai/<model-id>
```

Replace `<model-id>` with an OpenAI model supported by Pi. The same proxy is available in `pis --bash` and `pis --exec`.

The provider's matching host login profile is selected automatically. The environment-key route has been removed: `OPENAI_API_KEY`, `BERGET_API_KEY` and `MISTRAL_API_KEY` are ignored as host credential sources. A missing login stops launch with a `pis --login PROVIDER` instruction, even if such a variable is set. `pis --build`, `--check`, and `--show` do not require a login. Existing stored profiles work unchanged; no logout, credential replacement or re-entry is required. The old optional `profile` field is still accepted only if it matches the provider, for compatibility; new configuration needs only `provider`.

`credentials.env` must always be `[]`. Direct host credential forwarding has been removed. Older configurations with nonempty `env` fail validation rather than silently changing provider or exposing a key. To migrate, run `pis --login openai` (or the selected API provider) if no login was saved, explicitly remove `keyEnv`, keep the rest of the project policy, and use `{ "env": [], "proxy": { "provider": "openai" } }`. Active legacy `keyEnv` settings produce a migration error rather than being silently rewritten or interpreted as a new credential source. Since invalid stored projects can block normal registry selection/`pis --edit`, remove that field directly in the host project file first (`$PIS_HOME/projects/ID/project.json`, default `~/.local/share/pis/projects/ID/project.json`), preserving all unrelated fields. Then normal edit/check commands work again. Inert examples from older configurations are not credential sources; new generated examples omit keyEnv. Omitting `proxy` allows a credential-free launch, not host key forwarding.

## Host API-key profiles

Manage host-only API-key profiles explicitly:

```sh
pis --login openai       # fixed OpenAI URL, hidden key prompt
pis --login berget       # Berget URL, hidden key prompt
pis --login-mistral      # Mistral API key, hidden prompt (alias: pis --login mistral)
pis --login custom       # trusted public HTTPS endpoint/model setup, then hidden key
pis --login ollama       # keyless model setup for literal loopback HTTP on the agent host
pis --login-status       # provider/profile presence only, no values
pis --logout berget      # removes local copy; does not revoke the provider key
```

Profiles live in `$PIS_HOME/auth/` (default `~/.local/share/pis/auth/`), are written atomically with mode 0600 inside a 0700 directory, and are never mounted into the container or included in image builds. Login does not make a paid API request. Cancellation or invalid input does not save a partial profile. `pis --show` and `--login-status` report profile/provider and credential presence only, never key values.

To select a stored Mistral key, set `credentials.env` to `[]` and use `{ "provider": "mistral" }` after `pis --login-mistral`. Pi's native Mistral Conversations provider sends `POST /v1/chat/completions`; the host fixes the destination to `https://api.mistral.ai/v1/chat/completions`. Only this chat route is available, not other Mistral API routes. `--login-mistral` does not implement a subscription sign-in.

For Berget, run `pis --login berget`, set `credentials.env` to `[]` and use `{ "provider": "berget" }`. The matching saved login is the only credential source; missing/invalid profiles fail closed without environment fallback.

`pis --login custom` asks for an HTTPS API base URL ending in `/v1`, confirmation of tool-call support, verified model IDs, published context/output limits, image-input and reasoning capabilities, and a hidden API key. Only OpenAI Chat Completions is supported; no discovery, model-list, or live validation request is made. The custom model catalog belongs to the host profile, not `credentials.proxy.models`. Project config only needs `provider: "custom"` (a matching legacy `profile` is optional), never the endpoint or key.

Custom destinations must use HTTPS on port 443, with no URL credentials, query, or fragment, and a safe path prefix ending in `/v1`. IP literals, local hostnames, and DNS results in private/special-use ranges are rejected. DNS answers are resolved and pinned when the host proxy starts; requests use only `/v1/chat/completions` with the configured base path prefix and never follow redirects. Loopback HTTP remains available only to the internal fake-service test seam. This does not constrain container egress generally.

## Local Ollama (explicit host-loopback profile)

Run these on the **host owning the Pi project**, not inside the sandbox. Start/configure Ollama separately on loopback; pis does not install/start Ollama, download models, change its listener/firewall or run a health/inference probe. If the web controller/browser is on another machine, `127.0.0.1` here still means the agent host, not that controller/browser.

```sh
pis --login ollama
pis --edit
```

Accept the default `http://127.0.0.1:11434/v1` or supply another literal loopback HTTP `/v1` address. Enter installed model tags (for example `qwen2.5-coder:7b`), confirm tool/function-call support and give each model's **actual Ollama-configured context window (`num_ctx`) and output budget**, plus image/reasoning capabilities. These are user-provided limits, not discovered/certified model maxima. Wrong limits can make compaction/context percentage misleading or cause rejected/truncated requests. Pi must use a model that genuinely supports streaming/tool calls. No API key is requested or stored, and login makes no model-list, download or completion request.

Use this project configuration:

```json
"credentials": {
  "env": [],
  "proxy": { "provider": "ollama", "models": [], "maxRequests": 1000, "maxConcurrent": 4 }
}
```

Select the Ollama model explicitly in Pi (`/model`) or launch interactively with:

```sh
pis -- --model ollama/qwen2.5-coder:7b
```

Replace that tag with your installed/profile-configured model. Provider setup does **not** silently change an existing saved Pi model/session. For web RPC, choose/save the model from Pi's terminal UI first (Ctrl+S in the model selector saves the startup choice), then connect the project normally; web runtime startup flags remain fixed. No real credentials or destination URL belong in project JSON or mounted Pi auth files.

The host stores a private 0600 `$PIS_HOME/auth/ollama-local.json` (0700 auth directory) with version/provider, `auth: "none"`, URL and bounded model catalogue, never an API key. `--login-status` reports `profilePresent: true`, `credentialPresent: false`; that is expected and is **not** an online availability check. `pis --logout ollama` removes only this setup, not the Ollama service/models, other providers, active proxy or explicit project selection. Profile changes apply on the next proxy/agent launch.

The URL policy is intentionally separate from public `custom`: only literal `http://127.0.0.1[:PORT]/v1` or `http://[::1][:PORT]/v1` is accepted. DNS names (including `localhost`), LAN/metadata/unspecified/mapped addresses, unusual IP spellings, credentials, queries/fragments, encoded/traversal/other paths and redirects are rejected. The local HTTP agent does not inherit environment/global-agent proxy routing. Public `custom` still requires public-DNS HTTPS/443 plus checked/pinned public resolution; no private-address exception is added there. Authenticated local reverse proxies, arbitrary LAN endpoints and managed SSH tunnels for Ollama are not implemented.

Sandbox clients receive only the usual per-run dummy capability and read-only `ollama` model/auth overlays through the existing Unix relay; no host network mode, engine socket, new mount or direct backend port is exposed. Only `POST /v1/chat/completions` is admitted. No upstream Authorization/cookies/client API keys are forwarded. `/api/pull`, tags/show/create/delete routes, `/v1/models`, Responses, arbitrary URLs and CONNECT/upgrades remain blocked. Empty project `models` means **only configured profile model IDs** for Ollama; a nonempty list must be a subset. Existing request/concurrency/body/response/time limits and generic errors still apply. Startup itself makes no backend request. The OpenAI-compatible overlay uses `max_tokens`, system roles, no `store` or unverified reasoning-effort control; reasoning/vision declarations do not prove hardware/backend support.

Loopback restricts the proxy hop, not Ollama's own behavior: a cloud-backed Ollama tag or modified service could send data elsewhere. Choose genuinely local models if that is required. Local inference can still consume significant CPU/GPU/RAM and permits the model's ordinary sandbox tool capabilities; it does not make tools/web extensions network-offline or provide an unattended host approval mechanism. Ollama does not supply the provider-hosted Responses/web-search API.

Verification: unit/CLI/profile tests and a fake local HTTP upstream cover strict addresses, keyless storage, other-login preservation, private files, exact routes/allowlist, capability authentication, header stripping, stream forwarding and redirect rejection. An opt-in installed-Pi 1.5.2 fake-fetch probe verified `max_tokens`/roles and streamed tool-call parsing with real sockets blocked, without contacting any model (image pin unchanged):

```sh
PIS_PI_PACKAGE=/path/to/installed/pi-package node --test test/ollama-compatibility.test.js
```

Actual Ollama/model/hardware behavior and the real-Podman relay remain host verification gates. No live local/paid model was used as a smoke test.

## Berget model catalogue

At each normal Berget-proxy startup the host makes **one public, credential-free GET** to `https://api.berget.ai/v1/models`. This is metadata discovery, not a completion/model request. It sends only an Accept header, omits cookies/authentication, rejects redirects, times out after five seconds (including body reads), and bounds the decoded response to 512 KiB, 256 catalogue entries and 100 accepted chat models. No remote URLs, headers, credentials, commands, compatibility objects or price fields enter the generated Pi overlay. The sandbox still cannot call a model-list route; the existing Chat Completions POST allowlist and limits are unchanged.

Only text/chat entries explicitly advertising streaming and function calling are included; embeddings, rerank, speech, System One/decision and retired entries are excluded. Active, preview and deprecated-but-not-retired chat entries can appear; catalogue inclusion is not a compatibility/production endorsement. Canonical IDs are used, not aliases. Images are enabled only when the catalogue explicitly advertises vision. Pi effort controls are not enabled by default because Berget's effort-control protocol has not been verified. **This does not disable the model's server-side reasoning.** In particular, GLM's model-author documentation says thinking is always enabled and defaults to max effort when unspecified. Its reasoning and answer can consume a shared output budget; hiding reasoning in the UI does not give more tokens. EUR prices are **not** inserted into Pi's USD cost fields: Pi's displayed cost is not an accurate Berget invoice estimate.

When discovery fails (including unavailable/invalid/oversized/empty compatible catalogue), launch uses the bundled four-model snapshot: Gemma 4 31B, GLM 5.3 Flash, Kimi K3.1 Pro and Mistral Small 3.2 24B. There is no persistent cache, background refresh, retry loop or model call. Restart pis to refresh; no rebuild or fresh session is required. `credentials.proxy.discoverModels: false` disables the network read and selects that bundled snapshot. Startup progress reports only fixed source (`remote`, `fallback`, `bundled`), accepted count and a local-budget warning; never raw errors/responses. Fake injected upstreams default to bundled models so offline tests do not accidentally call Berget.

The public catalogue observed during implementation omitted context/output limits. Valid `context_length` / `max_output_tokens` integers are used if supplied; otherwise definitions use **local token budgets, not verified service ceilings**: the previous Gemma budget of 262144 context / 8192 output is retained; GLM 5.3 Flash uses **320000 context / 65536 output**; other models default to 32768 context / 8192 output, clipped to context if needed. GLM's context is published in [Berget's GA announcement](https://berget.ai/en/blog/kimi-k3-glm-5-3-flash-ga); its 65536-token output allowance is a local tuning choice for reasoning plus answer, **not a verified Berget output maximum**. Valid limits returned by the catalogue take precedence; explicit modelOverrides take final precedence. The higher GLM budget may increase latency and billed tokens. They may underuse a model's capacity and are not a guarantee that a provider accepts a given request. Supply verified limits explicitly when needed:

```json
"proxy": {
  "provider": "berget",
  "profile": "berget",
  "models": [],
  "discoverModels": true,
  "modelOverrides": {
    "moonshotai/Kimi-K3.1-Pro": {
      "contextWindow": 32768,
      "maxTokens": 8192
    }
  }
}
```

The numbers above illustrate the local budget, **not published Kimi limits**. Overrides require both positive integer limits (output no greater than context) and optionally `input: ["text", "image"]` / `reasoning`; no endpoint/headers/arbitrary config is accepted. They apply only to a matching discovered/bundled model and never add models or override the request allowlist. `models: []` still means unrestricted POST model IDs, not discovery. Explicit project configuration and stored sandbox auth/models files remain unchanged; the selected provider's per-run read-only overlay is rebuilt as before.

Sources: [public catalogue](https://api.berget.ai/v1/models), [console](https://console.berget.ai/models), [capabilities](https://docs.berget.ai/models/capabilities). The public catalogue was read without credentials; tests use fake catalogues/local HTTP and no live/paid inference. Real-provider streaming/reasoning/tool round trips and actual output ceilings remain unverified. An injected-fetch probe against installed Pi AI 1.5.2 (image pin still 1.5.0) confirmed the 65536 output value reaches the request and synthetic reasoning_content becomes a thinking block even with effort controls disabled; this is not a real Berget compatibility test.

### Truncated reasoning responses

Pi's terminal message `Response was truncated before completion.` indicates `stopReason: "length"` (typically provider `finish_reason: "length"`), not the web history/display cap. The former 8192 output budget could run out on reasoning before an answer or complete tool call. The GLM default is now 65536, but a provider cap, very long thinking, or input/context pressure can still truncate a response. The available output can be reduced by Pi to fit remaining context. Raising a ceiling does not guarantee completion and never automatically retries/replays a prompt or incomplete tool call. If this persists, collect model ID, whether reasoning/answer text appeared and safe token counts—not credentials or full transcripts—and verify the provider's actual limits. See [GLM author's thinking guidance](https://huggingface.co/zai-org/GLM-5.3-Flash) and [Z.ai model docs](https://docs.z.ai/guides/llm/glm-5.3-flash); model-author capabilities do not establish Berget serving parameters.

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

Only the Unix socket, dummy credentials, and container relay/configuration files are mounted at `/pis/proxy`. The host proxy implementation and real key are not mounted. As defense in depth, host `OPENAI_API_KEY`, `BERGET_API_KEY`, and `MISTRAL_API_KEY` are removed even for credential-free launches; the runtime gets only dummy values. The runtime directory is private (0700), its files/socket are 0600, and normal shutdown removes it. Forced process death can leave inert runtime files. They do not contain the host proxy credential, but preserved entries for other sandbox providers may contain previously stored secrets, so treat leftover runtime directories as sensitive.

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
| `mistral` | POST | `/v1/chat/completions` |
| `ollama` | POST | `/v1/chat/completions` |
| `openai-codex` | POST | `/backend-api/codex/responses` |
| `openai-codex` | GET | `/backend-api/wham/usage` |

Modes are separate: a Codex capability cannot call the standard API routes, or vice versa. Codex routes are fixed to `https://chatgpt.com`; OpenAI routes are fixed to `https://api.openai.com`; Berget routes are fixed to `https://api.berget.ai`. Custom and literal-loopback Ollama destinations are available only through their explicit, private host profiles described above.

All other paths, query strings, absolute URLs, HTTP CONNECT, and WebSocket upgrades are rejected. File management, response retrieval/deletion, images, audio, and Decisions/classifier endpoints are not supported yet. Sandbox requests and project JSON cannot select another upstream; only an explicitly managed host profile can configure a custom or local Ollama destination.

The Codex usage endpoint returns only validated numeric quota/reset windows and optional boolean `allowed`/`limit_reached` flags; identity, email, plan metadata, arbitrary fields, and tokens are discarded. A narrow container-only fetch adapter supports usage consumers. The opt-in host [`--wait-codex` startup gate](codex-wait.md) uses the same sanitized usage shape before opening a sandbox. Usage polls use the same capability, host refresh, limits, and request budget; no extra real credential is supplied to extensions.

`credentials.proxy.models` is an exact allowlist for POST request model IDs; an empty array allows any model except in Ollama mode, where it selects the configured host-profile catalogue. `/v1/models` is available only in OpenAI mode and is not filtered, so selecting a model outside the allowlist results in a rejection when generating a response. Berget and custom modes use a host-side Pi model catalog; those definitions are separate from the request allowlist.

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
