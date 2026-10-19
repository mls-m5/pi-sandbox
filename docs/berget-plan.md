# Plan: Berget AI and host-side API-key login

Status: implementation in progress on `feat/berget-api`. Core Berget proxying, host API-key profiles, custom trusted-endpoint profiles, and fake-service tests are implemented. Live-provider compatibility and real-container Berget/custom streamed tool round trips remain unverified.

## Goals

- Support Berget AI through the existing host-side credential proxy.
- Provide interactive login for API-key providers, with an endpoint URL prompt and hidden API-key input.
- Keep real keys in private host-only storage, never mounted into the sandbox. Pi and extensions receive only a per-run capability token.
- Preserve existing OpenAI/Codex behavior and environment-variable authentication for CI.

## Implemented behavior

- Codex retains host-side login/import/logout support.
- `pis --login openai|berget|custom`, `--logout`, and `--login-status` manage private host API-key profiles. OpenAI/Berget can also use an explicitly selected host environment variable.
- Berget is fixed to `https://api.berget.ai/v1` and initially permits only Chat Completions. It does not assume Responses or `/v1/models` support.
- Custom API profiles are host-only, HTTPS/public-DNS constrained, DNS-pinned per run, path-prefix aware, and limited to Chat Completions. Custom model metadata is entered by the user and stored with the host profile.
- Selected-provider Pi auth/model entries remain read-only per-run overlays. Real keys stay out of the sandbox, build context, and project JSON.

## Proposed user experience

Implemented commands:

```sh
pis --login berget
# API URL [https://api.berget.ai/v1]:
# API key: [hidden input]

pis --login custom
# API base URL (HTTPS, public host, /v1 path):
# Confirm tool support and enter verified model metadata
# API key: [hidden input]

pis --logout <profile>
```

Also provide a login-status command that reports profile/provider and credential presence, never keys. Named presets supply protocol/model defaults. A custom URL and key alone are not enough to determine API protocol and model capabilities.

## Implementation checklist

### 1. Host-side credential profiles

- [x] Design the profile schema, storage location, command syntax, and project profile-reference field.
- [x] Store keys outside repositories and sandbox state, using private directories/files (0700/0600), atomic writes, and appropriate locking.
- [x] Prompt for URL and hidden key; handle cancellation without saving partial credentials. Never echo or log keys.
- [x] Support logout and redacted status reporting.
- [x] Define explicit precedence between stored profiles and environment credentials; missing credentials fail closed rather than falling back.
- [x] Login performs no live/paid connection or model calls. Custom hostnames are safety-checked and pinned at proxy startup.

### 2. Berget provider preset and configuration

- [x] Add a distinct `berget` provider in configuration/schema, including defaults, inert examples, and hints.
- [x] Use `BERGET_API_KEY` as the default environment-variable source when not using a stored profile.
- [x] Update CLI help and credential diagnostics.
- [x] Keep existing project behavior and new-project defaults unchanged.
- [x] Keep credential values out of project configuration; reference a host-managed profile instead.

### 3. Proxy destination and route policy

- [x] Add fixed Berget origin `https://api.berget.ai`, with `/v1` API paths.
- [x] Initially support `POST /v1/chat/completions`; do not enable `GET /v1/models` without verification.
- [x] Do not assume Responses API support.
- [x] Preserve capability checks, model allowlists, limits, header rebuilding, streaming redaction, cancellation, and redirect rejection.
- [x] Use provider-neutral upstream errors and opaque printable API-key validation (no assumed `sk-` format).
- [x] Custom destinations are selected only through explicit host profile login, not project endpoint fields or sandbox requests.
- [x] Require HTTPS, reject URL credentials/query/fragment and private/special-use destinations, never follow redirects, and keep loopback HTTP only as an internal fake-service test seam.
- [x] Distinguish API base URLs (including path prefixes) from origins; join paths explicitly and test route prefixes and unsafe traversal inputs.

### 4. Pi model overlays

- [x] Generate a Berget provider overlay with loopback base URL, dummy key, `api: "openai-completions"`, and an explicit initial model definition.
- [x] Begin with the documented tool-capable `google/gemma-4-31B-it` model. Berget capability docs list tool use and multimodal input; see remaining metadata caveat below.
- [ ] Verify context/output limits, input capabilities, pricing, and compatibility settings against the pinned Pi version and current Berget documentation; do not guess.
- [x] Keep model catalogs separate from `credentials.proxy.models`, which remains an exact request allowlist.
- [x] Preserve original state files and existing file/symlink safety checks; replace stale selected-provider endpoints/headers.

### 5. Container isolation

- [x] Resolve provider-specific key defaults across runtime preparation, diagnostics, and container launch.
- [x] Strip actual selected host keys from Podman build/run subprocess environments; never add credentials to build context or image instructions.
- [x] Expose only per-run capability credentials and loopback URLs inside the sandbox.
- [x] Retain read-only auth/model overlays and the private Unix-socket relay.
- [x] Keep Codex-specific fetch/usage bridging restricted to Codex; no bridge changes required.

### 6. Tests and documentation

- [x] Unit tests cover profile storage/permissions, hidden login/cancellation, logout/status, precedence, configuration, and URL validation.
- [x] Fake-upstream tests cover Berget/custom paths and key injection; existing proxy tests cover route/model rejection, redirects, limits, cancellation, streaming, and split-key redaction.
- [x] Verify credentials stay out of container arguments/environment and overlays. Broader build/log redaction remains covered by shared proxy/build tests.
- [ ] Real-container tests with actual Pi for streamed text, streamed tool calls, and tool-result round trips; use fake credentials/upstreams and disable container networking where feasible.
- [x] Retain OpenAI/Codex regression coverage.
- [x] Update README, proxy documentation, and this setup/implementation guide.
- [ ] Perform an optional live Berget smoke test only after explicit approval. Fake-service tests do not establish real-service compatibility.

## Remaining verification

- Berget's output-token limit in the Pi overlay is provisional and has not been independently verified; confirm it before treating the model metadata as authoritative.
- Add real-container Berget/custom tests using fake upstreams for streamed tool calls and tool-result round trips.
- Live-provider compatibility remains unverified; run a small live smoke test only with explicit user approval.

## References

- https://docs.berget.ai/quickstart
- https://docs.berget.ai/integrations/pi
- https://docs.berget.ai/models/capabilities
- `docs/proxy.md`
- `docs/codex.md`
