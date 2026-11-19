# Claude Code in the pis sandbox (experimental)

This mode runs Anthropic's **unmodified official Claude Code** in the project container, on your Claude subscription. Pi remains the default agent. The subscription token stays on the host: the container gets only a fixed placeholder and a private Unix socket to a Claude-only host proxy.

## Start

Install official Claude Code **on the host** using [Anthropic's installation instructions](https://code.claude.com/docs/en/setup). The default host executable is `~/.local/bin/claude`; otherwise set `PIS_CLAUDE_BIN` to its absolute path. Executables in registered project roots, extra mounts or sandbox storage are rejected.

Once per host (global, shared by all projects in this `PIS_HOME`):

```sh
pis --login claude          # runs official "claude setup-token", then a hidden paste prompt
```

From a registered project:

```sh
pis --claude                # same as --agent claude; builds the image if needed
pis --claude -- --continue  # resume Claude's last session explicitly
pis --claude -- --resume    # Claude's session selector
```

If no login is saved, an interactive `pis --claude` offers to run the login first, so the first start can be a single command. Set `"agent": "claude"` via `pis --edit` to make Claude the project's default; `--agent pi|claude` / `--claude` override it for one launch (also with `--show`, `--check`, `--build`, `--rebuild`, `--bash`, `--exec`).

Like Pi, Claude **continues the latest session by default**: pis adds `--continue` when this project's `claude-state/.claude/projects/<working directory with non-alphanumerics replaced by '-'>/` already holds a `*.jsonl` transcript. It adds nothing for a first start, `--fresh`, print/management commands, or when you pass your own `--continue/-c/--resume/-r/--session-id` etc. The directory layout is inferred from Claude Code's storage, not documented API: if it differs, pis simply starts a new session as before. Arguments after `--` are forwarded unchanged. Claude permissions and workspace-trust prompts are not bypassed. `--version`, `--help` and `auth`/`doctor`/`mcp` management commands work without a login. `pis --claude --bash` gets the same proxy when a login is saved, so `claude` can be run inside the shell.

Other commands: `pis --logout claude` removes the saved token (it is **not** revoked at Anthropic; revoke it in your Claude account settings if it may have leaked). `pis --login-status` reports presence only. `pis --login-claude` is an alias for `pis --login claude`.

## Credential flow

1. `pis --login claude` optionally runs host `claude setup-token` in a fresh host-only `CLAUDE_CONFIG_DIR`/working directory (no repository settings, hooks or existing login; host `ANTHROPIC_*`/`CLAUDE_*`, API-key and Node injection variables removed). You paste the printed long-lived token at a hidden prompt. The temporary directory is removed.
2. The token is saved as `$PIS_HOME/auth/claude-oauth-token.json` (0600 in a 0700 directory, no-follow/singly-linked/owner checks). It is never mounted, put in image builds, or passed as a container environment variable.
3. **Only subscription OAuth tokens (`sk-ant-oat…`) are accepted; Anthropic API keys (`sk-ant-api…`) are refused**, so this mode cannot silently switch to per-token API billing. There is no API-key fallback anywhere in the proxy.
4. Each Claude launch starts a host proxy listening on a private Unix socket in a fresh 0700 `/tmp/pis-claude-*` directory, mounted read-only at `/pis/proxy`. The container gets only:
   - `ANTHROPIC_UNIX_SOCKET=/pis/proxy/claude.sock`
   - `CLAUDE_CODE_OAUTH_TOKEN=ssh-placeholder` (Claude Code's own fixed placeholder for host-held credentials)
   - `ANTHROPIC_BASE_URL=http://pis-claude-proxy.invalid` (plain HTTP over the socket, never resolved)
   - `CLAUDE_CODE_OAUTH_401_WAIT_MS=0`
5. The proxy accepts only `POST /v1/messages` and `POST /v1/messages/count_tokens` (optionally `?beta=true`), JSON content. It forwards to the fixed `https://api.anthropic.com` with `Authorization: Bearer <token>` and the OAuth beta header added; client `authorization`/`x-api-key`, Host, cookies and forwarding/proxy headers are dropped, other headers are allowlisted (Anthropic version/beta, user agent, `x-app`, session/request IDs, `x-stainless-*`). Redirects are refused. Anthropic responses, including error bodies (overload, rate limit, context length), are streamed back with only content type, request ID, retry and `anthropic-ratelimit-*` headers; the token is redacted from response bytes. Other routes get a 404 Anthropic-style error. Per launch: 16 concurrent / 20000 requests, 32 MiB request bodies, 10-minute upstream idle timeout. Nothing is logged except, with `PIS_CLAUDE_PROXY_DEBUG=1`, a sanitized list of refused route paths at exit.
6. Rotation is not an issue: a `setup-token` token is long-lived and is never refreshed in the sandbox, and only the host holds it. All projects can share it concurrently.

The per-project `claude-state/` home (mounted at `/pis/home`, `CLAUDE_CONFIG_DIR=/pis/home/.claude`) keeps Claude's sessions, settings and history. Pi's `state/` is not mounted in Claude mode and vice versa.

### What the boundary does and does not protect

- A process in the sandbox **cannot read or exfiltrate the subscription token**.
- While a Claude container runs, any process in it **can use the socket** to make model calls on your subscription (within the per-launch limits), just as Pi sandbox processes can use the Pi proxy. Treat the agent's quota use accordingly.
- The proxy is Claude-only: it is started only for `agent: claude`, and launch arguments refuse to give it to Pi. Pi's `credentials.proxy` settings are kept unchanged for switching back and are never started in Claude mode. Anthropic's terms do not allow subscription OAuth to be used by other clients; this mode only routes the official Claude Code client's own calls.
- Claude Code still has normal container networking for git, package managers and web tools. Only model authentication goes through the host.

### Diagnosing 401 / "Please run /login"

Start with `PIS_CLAUDE_PROXY_DEBUG=1 pis --claude` and read `$PIS_HOME/claude-proxy.log` (private, content-free, truncated above 256 KiB). It records when the proxy started with the token **kind** (e.g. `oat01`) and how long ago the host login file was saved, then one line per call (`POST /v1/messages -> 401 request-id=req_… error=authentication_error: …`), refused non-model routes, and the number of forwarded requests at exit. No headers, bodies, prompts or tokens are written. How to read it:

- **`-> 401 … authentication_error` from upstream:** the host token itself is rejected by Anthropic (expired, revoked, logged out everywhere, wrong account). Run `pis --login claude` again. The login file age tells how old it is; a login file saved before the token was replaced elsewhere is stale.
- **No 401 lines, or "proxy closed after 0 forwarded request(s)", but Claude shows 401:** the failing call did not go through the proxy. Container networking is open, so a request to another Anthropic endpoint (profile, usage, token refresh) can reach Anthropic directly with the fixed placeholder and get 401. Look for `refused …` lines naming such routes.
- **200 lines but a 401 only in the Claude UI:** a stale `.credentials.json` in the sandbox (removed automatically at start when a host login exists, see below).

### Migration from the earlier per-project login

Earlier versions (and a `/login` run inside the container) can leave real access/refresh tokens in `projects/<id>/claude-state/.claude/.credentials.json` (and a host snapshot `auth/claude-<id>.json`). Such a stale login can override the proxy placeholder and fail with `401 OAuth access token is invalid · Please run /login`. **Starting `pis --claude` now removes these old copies automatically when a host login is saved**, printing one line; sessions, settings, history and the global host token are untouched, and the removed tokens are not revoked at Anthropic. If no host login is saved the old copy is kept (it may be your only working login) with a warning; run `pis --login claude` and it is removed at the next start. Do not run `/login` inside the container: it stores real tokens in the sandbox again (they will be removed at the next start). `pis --logout-claude` still removes the saved global token as well and is not needed for this cleanup.

## Host apt and Git requests from Claude (experimental)

Interactive `pis --claude` starts the same typed proposal socket as Pi (mounted read-only at `/pis/apt`) and passes `--mcp-config` for an image-owned stdio MCP server, `/opt/pis/claude-host-mcp.mjs` (dependency-free, tools `mcp__pis-host__request_apt_packages` and `mcp__pis-host__request_host_git`; Claude Code may ask permission on first use). The tool can only **suggest**: it sends the validated-by-host apt proposal, returns, and sends `SIGTERM` to its parent (Claude Code). When the container ends, pis removes/verifies it, then shows the usual host prompt with a fresh two-digit code. Approval adds the packages, rebuilds and restarts `claude --continue "<notice>"`; the notice starts a model turn (uses tokens). Decline changes nothing. Your own MCP servers are not disabled. Not offered for `--bash`/`--exec`, print mode, web or non-TTY runs. `request_host_git` accepts exactly the Pi tool's typed form (`repo`, `args: ["push", REMOTE, FULL_COMMIT:refs/heads/BRANCH]`, `reason`) and reuses the host-side snapshot, verification, confirmation code and non-force push described in [host-actions.md](host-actions.md#host-git-commands-push-implemented); after success Claude restarts with a continuation notice (uses tokens). Decline/failure restarts nothing. The web `--allow-web-git` flow remains Pi-only.

Offline tests cover the MCP protocol, the real proposal socket, rejection of malformed/extra-field requests and that an accepted request SIGTERMs the parent process. **Verified on a real host (apt):** the tool appears, SIGTERM stops Claude, the host prompt, rebuild and `--continue` restart work. **Verified on a real host (Git push):** one approved push of an exact commit to `main` through this tool succeeded and Claude restarted with the continuation notice. The user also reported the session continuing after restart; whether the earlier conversation history was fully preserved was not independently checked. If SIGTERM ever proves unclean, replace the stop mechanism (e.g. a signal the image wrapper watches).

## Cached usage display

The proxy also stores the numeric 5-hour/7-day utilization and reset times from `anthropic-ratelimit-unified-*` response headers in `$PIS_HOME/claude-usage.json` (private, no other header or body data; best effort, failures never affect traffic). `pis --claude-usage` prints the sanitized cache and the GNOME widget shows it ([details and unverified header format](../gnome-codex-usage/README.md#claude-usage-cached-experimental)). It updates only while Claude Code is used.

## Image and unavailable Pi features

Claude images add pinned `@anthropic-ai/claude-code@2.1.328` (the version whose Unix-socket placeholder mode was inspected). npm lifecycle scripts are disabled; the package's `install.cjs` is then run explicitly to place its platform-native binary, and `claude --version` checks the build. The binary is unmodified. Runtime `DISABLE_UPDATES=1` keeps updates controlled by image rebuilds. No credentials are supplied to builds. The version bump changes Claude image fingerprints, so the next Claude launch rebuilds.

Pi packages/extensions are not Claude plugins. Claude launches do not expose Pi's apt/Git proposal socket or automatic post-approval restart flow. Host `ANTHROPIC_*` and `CLAUDE_*` variables are stripped from Podman subprocess environments. Web/RPC mode and managed updates remain Pi-only.

## Verification and limits

Fast tests (no network, no real login, no model calls) use a fake Anthropic upstream, fake TTY and fake Podman. They cover token validation (API-key refusal, private-file checks), isolated `setup-token` login, header/route filtering, token injection and redaction, error-body forwarding, redirect refusal, budgets, launch arguments (placeholder-only, Claude-only proxy), legacy cleanup and CLI flow.

An opt-in real-Podman test (`npm run test:integration`) builds the image, runs the native binary only with `--version`, and sends one request from inside a `--network=none` container through the mounted socket to a host fake upstream, checking that the token is injected on the host and absent from the container. It has not been run in the development sandbox.

**Not yet verified end to end:** real `claude setup-token` login, Claude Code actually honoring the socket/placeholder mode in the container (inferred from the 2.1.328 binary and Anthropic's own nested-runner usage, not documented public API), subscription features over the proxy (usage display, model list, account-dependent features may be missing or degraded), and a real model call. Verify on the host with a small prompt. If Anthropic changes these mechanisms or required headers, this integration needs updating; do not fall back to mounting host credential files.

References: [authentication](https://code.claude.com/docs/en/authentication), [CLI reference](https://code.claude.com/docs/en/cli-reference), [legal and compliance](https://code.claude.com/docs/en/legal-and-compliance).
