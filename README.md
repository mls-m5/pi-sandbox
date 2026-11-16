# pis — Pi in a Podman sandbox

`pis` is a Linux-only CLI that runs the entire [Pi coding agent](https://pi.dev) inside a rootless Podman container. An experimental `--agent claude` mode runs official Claude Code with separate state and a different credential boundary.

**Status: working initial implementation.** Project registration, editable configuration, custom images, additional mounts, persistent Pi state, shell/exec modes, and diagnostics are implemented. Host-side OpenAI and Berget API-key proxy modes and ChatGPT/Codex OAuth proxy mode are implemented. JSON extension install sources, build-time installation, and automatic configuration hints/schema completion are implemented.

## Requirements

- Linux, running as a normal user (not root).
- Node.js 22.19 or newer.
- Local, rootless Podman with subordinate UID/GID mappings configured.
- Podman's init helper, usually supplied by the `catatonit` package.
- Network access to build the image and use model APIs.
- Vim, or another editor configured through `$VISUAL` / `$EDITOR`.

Tested on Ubuntu 24.04 with rootless Podman 4.9.3 and crun. SELinux behavior is implemented but has not yet been tested on an enforcing host.

The CLI has **no npm dependencies** and runs directly from the checkout.

If your terminal selects an older Node, check `node --version`. Sourcing `env.sh` automatically prefers Pi's bundled Node when it is installed at the following path; you can also prepend it manually:

```sh
export PATH="$HOME/.local/share/pi-node/current/bin:$PATH"
node --version
```

The launcher checks the Node version before loading modules that require newer built-ins.

## Try without installing

```sh
source ./env.sh
pis --help
```

This adds the checkout's `bin/` directory to PATH in the current Bash terminal only. If Pi's bundled Node is installed at `~/.local/share/pi-node/current/bin/node`, it is also prepended to PATH so `pis` uses it. No shell configuration files are changed.

## Install from this checkout

```sh
# From this repository:
mkdir -p ~/.local/bin
ln -s "$PWD/bin/pis.js" ~/.local/bin/pis
# Ensure ~/.local/bin is on your PATH.
pis --help
pis --doctor
```

Alternatively, run `./bin/pis.js` directly, use `npm exec -- pis`, or install the checkout with `npm link` using a user-writable npm prefix. No compilation is required.

## Quick start

```sh
cd ~/Prog/my-app
pis --new --name my-app
pis --edit
pis --login-codex              # Once on the host; shared by projects in this PIS_HOME
pis
```

The first launch builds an image with Node, Pi, Bash, Git, ripgrep, and CA certificates. Later launches reuse it. Interactive terminal launches print startup stages with elapsed time on stderr: image ready, credential proxy preparation, container start, then Pi/session/extension loading. The build completion line does not mean Pi is ready yet. These timings help locate a slow stage; they are not an estimate of remaining time. Protocol/custom-stdio launches do not enable startup progress. `pis --new` registers the directory; it does not launch Pi or build the image.

By default `pis` runs **`pi --tui-mode regular --continue`**. Pi uses sandbox-local state, not your host Pi installation or configuration. Pass an explicit `--tui-mode` after the wrapper separator to choose another Pi TUI mode. New projects use host Codex OAuth and give Pi a temporary dummy capability; real credentials stay outside the container. Existing projects retain their previous credential settings; see [enabling the proxy](docs/proxy.md#enable-it) to switch.

```sh
pis -- --model <model-id>       # Continue with additional Pi arguments
pis --fresh                    # New conversation, same project
pis --fresh -- -p "Run tests"   # Fresh noninteractive task
pis -- --resume                # Explicit selection replaces default continuation
pis --bash                     # Interactive Bash in the same environment
pis --exec -- python3 -m pytest
pis --exec -- bash -lc 'make test && git diff'
printf 'Explain this project' | pis --fresh -- -p
```

Arguments after `--` are passed unchanged to Pi, or to the program selected by `--exec`. Shell interpretation only occurs when you explicitly invoke a shell. Pi management subcommands such as `pis -- auth check --provider openai` do not receive implicit continuation.

## Claude Code (experimental)

Install official Claude Code on the host, then from a registered project:

```sh
pis --login-claude               # Project-specific host browser login
pis --agent claude               # Official Claude Code in the container
pis --agent claude -- --continue # Resume explicitly (default is a new session)
```

Host login uses `~/.local/bin/claude`, or the absolute `PIS_CLAUDE_BIN` path. Set `"agent": "claude"` via `pis --edit` for a persistent choice; Pi remains the default otherwise.

**Unlike Pi's proxy mode, real Claude access/refresh tokens are readable and writable inside the Claude sandbox.** Only a copy is supplied: personal host Claude files and the retained original are not mounted. Separate persistent `claude-state/` lets Claude renew tokens without modifying the host original. Startup never overwrites refreshed tokens. Pi's proxy settings are ignored, not changed, and Pi's apt/Git approval tools are unavailable in this mode. Run `pis --logout-claude` to remove this project's current credential copies (not remote revocation or backup scrubbing).

Real subscription login, copied-login onboarding and token rotation still need host verification; no live model calls have been made. See [Claude Code setup, security and testing limits](docs/claude-code.md).

## Codex subscription sign-in

For Pi's `openai-codex` provider, sign in on the **host**:

```sh
pis --login-codex
# Or explicitly copy an existing host OAuth sign-in:
pis --import-codex ~/.pi/agent/auth.json
# Codex CLI file-based ~/.codex/auth.json is also supported.
```

Use `pis --edit` to set `credentials` to:

```json
{
  "env": [],
  "proxy": { "provider": "openai-codex" }
}
```

Remove any old `keyEnv` field; keep the rest of the project configuration. Start `pis` and select a Codex model using `/model`, or pass `pis -- --model openai-codex/<model-id>` explicitly. The real access/refresh tokens remain in private host storage and refresh there automatically; Pi and extensions get only a synthetic proxy token. `pis --logout-codex` removes only the selected local host profile; other saved accounts remain.

Prefer a dedicated sign-in: importing copies rotating tokens without synchronizing the original client. See [Codex setup, imports, and limitations](docs/codex.md). Live subscription sign-in is not covered by the fake-service tests.

### Multiple Codex accounts

The existing login is named `default`. Run management commands on the host:

```sh
pis --login-codex --codex-account spare  # Choose another account in the browser
pis --codex-accounts                    # Aliases and selected/automatic status
pis --codex-use spare                   # Switch subsequent requests, including live proxies
pis --codex-use default
pis --codex-auto-switch default,spare   # Optional ordered pool; OFF by default
pis --codex-auto-switch off
pis --codex-usage --codex-account spare
pis --logout-codex --codex-account spare # Other accounts untouched; no remote revocation
# Optional: rename your original login without signing in again:
pis --codex-rename primary --codex-account default
```

Selection/pooling is global per `PIS_HOME`. Pool members must be authorized to receive **the same project and conversation history**; new logins never join a pool implicitly. Automatic routing confirms exhausted subscription quota and an available enrolled alternative. It does not switch on an ordinary 429/auth/network error, reset proxy budgets, change provider/model, replay an upstream request or interrupt an in-flight stream. Partial-turn recovery still uses native retries or opt-in `--auto-wait-codex`; account-bound remote history is not rewritten. After installing this host-code change, start the updated wrapper once; subsequent account switches do not require restarting Pi. [Storage, privacy, routing and verification details](docs/codex.md#multiple-accounts-and-live-selection).

### Wait for Codex quota and continue

After exiting a quota-limited Pi session, run:

```sh
pis --wait-codex
```

This opt-in mode checks host usage every one to five minutes, considers an explicitly configured account pool, waits until the returned short/weekly limits allow work, then starts the latest saved Pi session with an English continuation prompt (**uses model quota**). Ctrl-C cancels. No container or model request runs while waiting. It requires the Codex proxy and a saved session; no `--fresh` or trailing agent arguments. Usage/auth/network errors stop safely without starting Pi. This flag alone does not monitor an already running agent or switch to paid API access. See [behavior, session selection and verification limits](docs/codex-wait.md).

For automatic handling during a long-running **terminal Pi session**:

```sh
pis --auto-wait-codex
# New task, with automatic quota wait/resume enabled:
pis --fresh --auto-wait-codex -- "Work through the agreed implementation plan and tests"
```

After a quota-like Codex error, the host must independently confirm exhausted usage. Pi stays idle in the **same session and branch** while the host polls; once quota returns, an English continuation prompt resumes the task (**uses tokens**). No initial task or tool call is blindly replayed. Ordinary/transient errors do not trigger unconditional retries. Escape/Ctrl-C, new input or session/model changes cancel pending continuation; `/codex-auto off` disables it in the current extension runtime. Print/JSON/RPC and disabled sessions/extensions are not supported. Keep the terminal/host alive (e.g. `tmux`); permissions and host approvals still require you. See [automatic-mode safety and testing limits](docs/codex-wait.md#automatic-wait-during-a-run). Real subscription exhaustion/refill with the full Pi TUI remains unverified here.

## Berget AI and host API-key profiles

Berget uses the host-side credential proxy; its real API key stays in private host storage after login. To save the key interactively and use the built-in Berget model preset:

```sh
pis --login berget                 # prompts for URL and hidden key
pis --login-status                 # provider/profile presence only; never prints keys
pis --edit
```

Set the active credential configuration to:

```json
{
  "credentials": {
    "env": [],
    "proxy": { "provider": "berget", "models": [], "maxRequests": 1000, "maxConcurrent": 4 }
  }
}
```

Then run `pis --fresh -- --model berget/google/gemma-4-31B-it`, or use `/model` to select another Berget chat model. At each launch pis now fetches Berget's public catalogue (`GET https://api.berget.ai/v1/models`, no API key) and includes its streaming/tool-capable chat models. The offline fallback contains Gemma 4 31B, GLM 5.3 Flash, Kimi K3.1 Pro and Mistral Small 3.2 24B. Set `credentials.proxy.discoverModels` to `false` to use only that bundled list. Decision, embedding, rerank and speech models are not agent chat models and are excluded. Missing provider token limits use **local budgeting defaults**, not verified output ceilings (GLM now has 320000 context / 65536 output to leave room for thinking plus its answer; the higher output allowance can cost more and does not guarantee completion); `credentials.proxy.modelOverrides` can supply explicit context/output limits. See [catalogue policy and metadata overrides](docs/proxy.md#berget-model-catalogue). The sandbox route remains Chat Completions only; `/v1/models` and Responses are not exposed through its proxy. The matching saved login is selected automatically; environment API keys/`keyEnv` are no longer supported. `pis --logout berget` removes the stored profile; it does not revoke the provider key.

For Mistral API-key access (not a subscription), run `pis --login-mistral` on the host and change the project's `credentials.proxy` to `{ "provider": "mistral", "models": [] }` in `pis --edit`. Remove `keyEnv` and retain `credentials.env: []`. Use `pis --fresh` and select a `mistral` model in `/model`. The key stays in private shared host storage and only native `POST /v1/chat/completions` is proxied; `pis --logout-mistral` removes the local copy without revoking it. A future subscription login would require a separate authentication flow. Other API-key profiles can be managed with `pis --login openai` / `pis --logout openai`. For an OpenAI-compatible custom endpoint, `pis --login custom` asks for an HTTPS base URL ending in `/v1`, tool-call support, verified model IDs and metadata, then a hidden key. Custom profiles support only OpenAI Chat Completions, require public DNS addresses on port 443, and reject local/private destinations. Project config selects `provider: "custom"`, whose saved login profile is used automatically; the URL, model catalog, and key are not stored in project JSON. There is no automatic model discovery or connection test. See [proxy behavior and limits](docs/proxy.md#host-api-key-profiles).

## Project discovery

Projects are explicitly registered, not inferred from Git repositories.

- `pis --new` registers the current canonical directory with a random five-character ID and an optional friendly name.
- Normal startup chooses the nearest registered project at or above the current directory.
- If none exists, `pis` complains and suggests `pis --new`; it does not create one silently.
- Starting in a subdirectory mounts the registered project root but starts Pi in that subdirectory.
- Nested projects exist only when explicitly registered with `pis --new`.
- Selecting a project from elsewhere starts at its root.

```sh
pis --list
pis --project k7m2q
pis --project my-app --bash
pis --relocate k7m2q            # Associate that project with the current directory
```

Relocation preserves project identity and state. It does not rewrite additional absolute mount paths.

## Configuration and packages

`pis --edit` opens a temporary draft using `$VISUAL`, `$EDITOR`, or `vim`. Only valid configuration is saved. Invalid edits leave the previous configuration intact; interactive use offers retry/discard, while noninteractive use retains the draft and reports its location.

Loading the selected project adds missing defaults and hints, writes an editor schema beside the configuration, and formats the JSON. The same completion runs after editing: newly supported fields appear automatically without overwriting existing values. Optional credential modes stay in inert examples; legacy direct-credential configurations fail validation with proxy migration instructions rather than being silently converted, and Codex never receives an API-only `keyEnv` field. An explicit `extensions: []` remains empty.

Configuration includes these editable fields. `project.json` accepts `//` and `/* ... */` comments; comments are parsed safely and may be removed when `pis` normalizes the file after loading or saving.

```json
{
  "extensions": [
    "npm:pi-web-access@0.40.0"
  ],
  "updates": { "enabled": false, "includePinnedExtensions": false },
  "image": {
    "packages": ["build-essential", "python3", "python3-venv", "make"],
    "extraInstructions": ["RUN npm install -g typescript"]
  },
  "mounts": [
    { "source": "/home/mattias/Prog/shared-library", "access": "read-only" },
    { "source": "/home/mattias/Data/test-fixtures", "access": "read-write" }
  ],
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

This is a partial example, not a complete replacement configuration. Keep the generated `version`, `id`, and `root` fields. Use your own canonical absolute paths. Omitted extra-mount access defaults to read-only.

Generated configuration also contains an **inert `examples` section**. Copy examples into active fields to enable them; examples themselves never share directories or execute instructions.

- New projects include `build-essential` and `python3` in `image.packages`. Existing projects keep their current package lists. Packages are Debian apt package names, optionally with versions. Common tools/Pi/image extensions now precede project apt additions in a cache-friendly shared prefix; custom instructions still run after project apt. Built-in npm installs remove their caches in the same RUN, not in a later whiteout layer. No mutable shared-base tag is used and running containers/old caches are untouched. Packages needing project OS tools **during extension installation** may require reviewed custom preparation after apt; see [image layout, compatibility and host benchmark](docs/image-storage.md).
- In an interactive `pis` session, Pi can call the built-in `request_apt_packages` tool for missing apt packages. The sandbox can only propose: Pi exits, then **the host terminal** displays the exact names and asks you to type a new two-digit confirmation code. Enter rejects the request. Approval updates the project configuration atomically, builds the new image and restarts Pi with the latest saved session (`--continue`). After a successful build, Pi receives one English user message listing the approved packages and asking it to continue the previous task. This automatically triggers a new model turn and uses model tokens. The original prompt is not replayed; normal later starts do not repeat the installation message. Extra one-off Pi CLI options are not replayed either. The tool is unavailable in noninteractive/print modes, `--no-session`, `--no-extensions`, and `--exec`/`--bash`. Package suggestions cannot add arbitrary shell instructions or npm packages. The host request protocol is typed; it rejects unknown actions rather than executing arbitrary commands. The separate `request_host_git` tool can request a host-side push with an independent confirmation showing the remote URL, branch and exact commit. See [host actions and Git authentication requirements](docs/host-actions.md#host-git-commands-push-implemented).
- Advanced customization supports single-line `RUN` instructions only, without trailing continuations or build mounts. These are trusted executable code.
- Changes to image settings or extension install sources trigger a build on the next launch; mounts, credentials, hints, and formatting do not.
- Tools installed into the disposable root filesystem disappear with the container. Manual Pi packages installed into the persistent sandbox home remain in project state.
- Credential configuration selects a provider, never key values or environment-key sources. New projects default to the `openai-codex` host OAuth proxy; run `pis --login-codex` before launching. Proxy mode never falls back to exposing credentials. Direct host credential forwarding is disabled: `credentials.env` must be `[]`, even without a proxy. For OpenAI API-key access, run `pis --login openai` and use `credentials.proxy: { "provider": "openai" }`. Old `keyEnv` fields must be explicitly removed; environment API keys are no longer read. Matching legacy `profile` fields are optional compatibility aliases. Legacy direct configurations must be updated explicitly; see [migration instructions](docs/proxy.md#enable-it).
- OpenAI API-key mode supports Responses, Chat Completions, and model listing; Berget, Mistral and custom profiles support Chat Completions only; Codex mode supports its separate ChatGPT Responses endpoint with host OAuth refresh. API providers use only their matching saved login profile; missing profiles fail closed without environment fallback. All modes have per-run request/concurrency limits; POST model allowlists are optional. See [proxy behavior and limitations](docs/proxy.md).

```sh
pis --check                    # Validate configuration and active paths
pis --show                     # Effective settings; no credential values
pis --build                    # Ensure the declared baseline image exists
pis --rebuild                  # Rebuild/select that baseline without cached build steps
pis --rebuild-defaults         # Explicitly add missing default Pi extensions, then rebuild
```

The Node base image is digest-pinned and Pi is pinned to 1.5.0. apt repositories and npm transitive dependencies are not fully locked, so uncached builds are not guaranteed to be bit-for-bit reproducible. The source baseline changes in `src/image-plan.js`; an opt-in managed updater can additionally stage tested Pi patch/npm plugin releases without source edits. Running sessions are never updated in place. Pi 1.5 changed the Codex model catalogue: if a previously saved model is missing, choose a supported model using `/model` and explicitly adjust any allowlist. See [managed updates and verification limits](docs/updates.md) and the [remaining design](docs/updates-plan.md).

### Automatic Pi/npm image updates (opt-in)

```sh
pis --updates all       # Enable once: Pi patches + compatible image npm updates, including pins
pis --updates on        # Or preserve exact plugin pins (keeps an existing prior 'all' choice)
pis --updates status
pis --updates check     # Optional immediate preparation/build, using only fake model services
pis --updates off       # Freeze the active release; no further checks/activation
pis --updates rollback  # Previous retained image, updates disabled; NOT a state restore
```

Checks run in a detached credential-free worker, at most daily after enable/start/exit. Exact candidates are built separately, SHA-512 checked and probed in a read-only, network-disabled container. They activate only on a later launch after a bounded private Pi-state backup. No task is interrupted/replayed and the update notice does not trigger a model turn. Default policy is off; `extensions: []` and declared sources remain unchanged. `PIS_AUTO_UPDATE=0` suppresses scheduling/activation. `--rebuild` selects the declared baseline for that invocation, not a reset of the active managed pointer.

Initial scope: Pi's pinned minor line (1.5.x), compatible stable npm plugin lines, no Git/watchdog, Claude or state-installed plugin updates. Backups cover persisted `.pi`, not project files or the whole home; image rollback does not revert migrated state. Real Pi 1.5/Web Access fake-service probes passed, but the complete new Podman build path still needs host verification. [Policy, rollback, backup and test details](docs/updates.md).

## User-approved host Git

In an interactive `pis` session, the agent can use `request_host_git` with one Git argument array. Initially only `push REMOTE FULL_COMMIT:refs/heads/BRANCH` is supported. Pi stops, then the host shows the destination and exact commit for your two-digit confirmation. After success Pi restarts and receives an English message so it can continue working. Declining does not push or restart.

The push runs on the **host**, from a verified temporary bare repository, not from the shared working tree. Repository hooks, Git aliases/configuration, URL rewrites and credential helpers cannot execute on the host through this feature. SSH uses your host agent/default keys and known-hosts file, but not `~/.ssh/config`; HTTPS can ask for credentials in the host terminal. This first version supports ordinary SHA-1 repos with `.git` directories and SSH/HTTPS on standard ports. See [the limitations and security design](docs/host-actions.md#host-git-commands-push-implemented).

## Image cleanup

Automatic cleanup is enabled by default for normal pis launches after a successful image build. A detached host process works in the background, skips locked projects and retries after the built session exits. A fully successful pass runs at most once per day; incomplete passes can be retried sooner. Disable automatic scheduling with `PIS_AUTO_PRUNE=0 pis`.

```sh
pis --prune --dry-run   # List eligible old pis image tags; delete nothing
pis --prune             # Remove eligible old pis images
```

Cleanup only considers fingerprint-tagged `localhost/pis-<id>` images for registered projects in the current `PIS_HOME`. It retains the configured image and the most recent other image (or two existing versions if the configured image is not built), images younger than 24 hours, images referenced by containers, and images shared with another repository/project. Managed active/candidate/previous image leases are also protected; invalid leases skip that project. Update staging tags and private Pi snapshots are not swept. Builds, sessions and cleanup use the same project locks; configuration changes are also locked during cleanup. Busy projects are reported as skipped. Deletion never uses force or recursive parent pruning.

This deliberately does **not** remove arbitrary Podman images, untagged build-cache layers, Buildah workspaces, volumes, project files, sandbox homes or credentials. Podman run containers already use `--rm`. You may still need occasional separate cleanup of abandoned build workspaces and dangling layers when no builds are running. The automatic worker records its last result in `$PIS_HOME/prune-report.json` (default `~/.local/share/pis/prune-report.json`); removal failures leave images in place and do not prevent Pi from starting.

## Extensions

Specify Pi install sources in `pis --edit`—not local installation paths:

```json
{
  "extensions": [
    "npm:pi-web-access@0.40.0"
  ]
}
```

`pi-web-access@0.40.0` and `pi-subagents@0.88.1` are the default packages when the field is missing. The former usage-bar package is no longer installed by default; the host-side GNOME extension in `gnome-codex-usage/` provides quota display instead. The image build runs `pi install` for each source with npm lifecycle scripts disabled. Packages live in the image and load automatically, including when you type `pi` inside `pis --bash`. No repeated `-e` flags or startup downloads are needed for these image packages.

```sh
pis --extensions-list          # Configured image install sources
pis --build                    # Build after changing sources (or just start pis)
pis -- list                    # Image sources plus manually installed Pi packages
pis -- --no-extensions         # Diagnostic run without image/discovered extensions
```

Use `"extensions": []` to disable all image defaults. Existing arrays are preserved during ordinary loading/builds, so removed packages are not silently re-added. Missing fields in older project files are completed on their next selected-project load.

To explicitly adopt missing current default extensions in an existing Pi project and force a fresh build, run **on the host**:

```sh
pis --rebuild-defaults
# Or select another registered project:
pis --project PROJECT_ID_OR_NAME --rebuild-defaults
```

This opts in even from an empty extension list. It adds missing package names, preserves existing custom sources/order/version pins and all other configuration, then builds the declared baseline with `--no-cache`. It does not start Pi or send a model request, update an existing pin, reset credentials/mounts/apt packages, or replace a running container. A busy project is refused; additions stay saved if the subsequent build fails so you can retry. Builds may download packages and consume disk; no image/cache purge is performed.

Supported install sources are `npm:<name>`, scoped npm packages, and optional exact versions or dist-tags. Default versions are pinned; unversioned/tagged sources require `pis --rebuild` or opt-in [managed updates](docs/updates.md) to fetch updates. Git sources and local source copying are not implemented. Local development through explicit `pis -- -e ./tools/my-extension.ts` remains supported.

Codex quota reads are routed through the credential proxy and return only validated usage windows and optional boolean availability flags. Web Access receives proxy-compatible defaults in sandbox `web-search.json`; existing explicit preferences are preserved. Neither package receives the real host token. See [extension setup and compatibility](docs/extensions-plan.md) for details and limitations.

Manual `pis -- install npm:...` still installs into writable project Pi state rather than the image. Avoid installing the same package both ways; remove its manual declaration when switching it to image configuration.

## Storage

Default: `~/.local/share/pis/`. Override with `$PIS_HOME`, or `$XDG_DATA_HOME/pis` when `PIS_HOME` is unset. Overrides must be absolute.

```text
~/.local/share/pis/
  index.json                    # Rebuildable cache; configs are authoritative
  auth/openai-codex.json         # Private host OAuth credentials; NEVER mounted
  auth/openai-api-key.json       # Optional private API-key profile; NEVER mounted
  auth/berget-api-key.json       # Optional private API-key profile; NEVER mounted
  auth/custom-api-key.json       # Optional private endpoint/model/key profile; NEVER mounted
  projects/k7m2q/
    project.json
    project.schema.json         # Generated editor descriptions/completions
    Containerfile               # Generated; do not edit
    build/                      # Generated Containerfile, manifest and bootstraps only
    state/                      # Persistent sandbox home and Pi state
    updates.json                # Private managed-release receipts, when enabled
    update-backup/              # Latest private pre-activation .pi snapshot; never mounted
```

Host Pi state at `~/.pi/agent` is not mounted. Conversations are stored in the project's sandbox state, with a shared session directory across invocation subdirectories. Pi still uses the invocation working directory for its own context/resource discovery.

Only one ordinary build/running container per registered project is allowed at a time. Opted-in update maintenance uses a separate private context/lock and may build/probe concurrently without touching the running session. Separate projects can run concurrently. Registry updates are also locked; conflicting edits are rejected rather than silently overwriting changes.

If a process is forcibly killed or the machine crashes, recover on the **host** with `pis --unlock --dry-run`, then `pis --unlock`. It checks the global `registry.lock`, any existing host-only `prune.lock` and the host-only Codex auth lock, and the selected/current project's `project.lock` and existing `updates.lock` without acquiring the stale registry lock. Only proven-dead owners are recovered; live/unknown owners, unsafe files and project locks with any remaining container are kept. Registry/prune-mutex/Codex-auth recovery needs no Podman and can succeed while an unrelated project is active. There is no force option and no container is killed/deleted. Recovery requires `/usr/bin/flock` (util-linux); its kernel guard releases automatically on process death. Normal launches never steal locks. New locks record boot/process-start identity and cleanup never removes another process's replacement lock.

No project/state deletion command exists; `--prune` only handles eligible image tags. Do not edit or delete state/configuration while its project is running. Old generated image tags can accumulate when image configuration changes.

## Security boundary

- Project and extra mounts preserve their absolute host paths, supporting file links.
- The project is read-write; explicitly shared directories default to read-only.
- Containers run with the invoking user's UID/GID, dropped capabilities, `no-new-privileges`, default seccomp, and a container init process.
- Host home, host Pi configuration, SSH agents, and container sockets are not automatically shared.
- Wrapper configuration is outside repositories; repositories cannot silently add wrapper mounts.
- On SELinux hosts, project/extra mounts use shared labels (`:z`) and state uses a private label (`:Z`). Relabeling changes host filesystem labels and may affect other applications.

**A writable mount permits the selected agent to change or delete those host files.** Secrets already in mounted directories, including `.env` files, remain accessible. Symlinks do not grant access to unmounted external targets. Resource limits are not configured yet.

**Proxy mode keeps host-provided API keys or Codex OAuth tokens outside the sandbox**, using a private Unix socket and a per-run dummy capability. Custom API profile destinations are host-selected HTTPS URLs, resolved to pinned public IPs, and limited to the profile's allowed route. No host TCP port is opened. Pi's selected provider auth/model entries are replaced with read-only per-run overlays; originals are unchanged. Previously stored credentials or secrets in mounted files remain visible; disabling host credential forwarding does not remove those secrets. The proxy does not retroactively scrub old state.

**Claude Code mode is an explicit exception to proxy credential isolation:** it uses a writable per-project copy of real subscription tokens. Commands inside that container can read or steal them. Pi and Claude use separate sandbox homes; neither personal host Claude state nor the host login snapshot is mounted. See [the Claude credential flow](docs/claude-code.md#credential-flow-and-the-weaker-security-boundary).

Hiding keys does not prevent API spending: sandboxed commands and extensions can use the capability within its host-enforced route/model/request limits. Outbound networking remains enabled; this is not a host/LAN access filter or exfiltration defense. Containers share the host kernel, not a VM-level boundary. Custom build instructions are trusted code; runtime keys and source are not supplied to builds. See [the proxy security notes](docs/proxy.md#security-boundaries-and-limitations).

## Local web demo (dummy agents, no model tokens)

Run in a **host terminal in this checkout**, with Node >=22.19 (not inside a sandbox if the browser is on the host):

```sh
npm --prefix web ci --ignore-scripts --omit=optional --no-audit --no-fund
pis --server
# Or directly from the checkout: ./start_server.sh
```

`pis --server` must put `--server` first and supports the same options, for example `pis --server --project NAME`. The web server itself runs on the host, **not in a sandbox**; real Pi agents retain their Podman sandbox. Separate least-privilege server isolation is tracked as future hardening in docs/web-control.md.

The launcher selects a compatible local/bundled Node or uses npm-provided Node 24 (may download on first use), without changing your default Node. Options: `./start_server.sh --port 43129 --agents 3`. With a supported Node already selected, `npm run web:demo` still works.

Choose a hidden temporary password of at least 20 characters, or press Enter to generate one and display it once in the terminal (warning: visible in terminal/log captures), then open **http://127.0.0.1:43128**. Select either dummy agent to try streaming chat, history, tools, stop and the **Simulera kvotstopp 5 s** button. For real projects you can open the URL as soon as the server announces it: terminal/GUI startup stages show whether it is checking Podman, preparing an image, starting Pi/extensions or waiting for agent registration. Once connections are ready the terminal stays open to run the server; it is not a stalled startup. The server binds loopback only; all demo credentials/history are memory-only and reset on exit. This does not launch Pi/Podman or spend model tokens. Experimental real Pi projects can be selected explicitly with `./start_server.sh --project NAME` (use `pis --list` for existing names/IDs); their prompts can spend quota/credits. This path has fake-Podman tests but has not been validated with real containers here. Git/apt web approvals, production quota-auto in RPC and Internet deployment remain unsupported. The first agent opens automatically after login. Opening/reopening an agent or reconnecting reads state first, then automatically fetches bounded recent history while following live work. Use **Hämta senaste historik** to refresh/retry manually; an over-limit history read is omitted without disabling agent control, and saved sessions remain unchanged. If state/history retrieval fails, use `pis --server --diagnostics --agents 1` to test the dummy first. The GUI now shows fixed error codes/references and a bounded diagnostics panel; share only those lines or terminal lines prefixed `pis web diagnostic:`, never passwords or whole auth/state/log folders. See [start options, safe diagnostics, security and verification limits](docs/web-control.md).

### Browser access through SSH

```sh
pis --forward ssh://alice@server.example
# Open the printed link: http://127.0.0.1:43128/
```

Defaults are SSH **22**, remote/local pis port **43128**. Keep the terminal open; Ctrl-C closes only this forward. A busy port fails instead of choosing a random one. For custom ports: `pis --forward ssh://alice@server.example:2222/43129` prints `http://127.0.0.1:43129/` (local and remote pis ports must match for Host/Origin checks). One browser forward serves multiple tabs/agents; separate `--connect` tunnels use private sockets and do not clash with it. Requires Node >=22.19 and OpenSSH/key login/verified known host on the client host; no automatic browser launch or password/key acceptance. Use the normal server admin login. See [setup, local-access limits and verification gaps](docs/web-agents.md#open-the-browser-ui-through-ssh).

### Standalone server and independently registered agents (local laptop test)

```sh
pis --server --standalone
```

Log in at **http://127.0.0.1:43128**. In another host terminal, save the default address once and connect from your registered project:

```sh
pis --connect --set-server http://127.0.0.1:43128
# Remote SSH host instead (defaults: SSH 22, pis 43128):
# pis --connect --set-server ssh://alice@server.example
cd /path/to/registered/project
pis --connect
# Enter the client's two-digit code under Väntande klienter in the server UI.
# Token-free alternative:
pis --connect demo-agent --dummy
# Explicit project selection / separate profile alias:
pis --connect laptop-app --server http://127.0.0.1:43128 --project PROJECT_ID
```

Bare connect selects the nearest registered Pi project containing the current directory. If no server is saved, it asks for and saves an address in an interactive terminal. Explicit `ssh://[USER@]HOST[:SSH_PORT][/PIS_PORT]` uses one private SSH tunnel per connector; ports default to 22/43128. Requires OpenSSH, key-based host login and a verified known-host key. `--server ssh://alice@server.example:2222/43129` overrides ports/destination for one run. A public HTTPS domain works only if SSH is separately reachable there; no server HTTP listener is opened. See [SSH setup and validation limits](docs/web-agents.md#ssh-forwarding-to-another-host-experimental). Named profiles still accept a registered ID/name or unique folder basename; `--project` overrides selection. The host-global address is private; `--server` overrides it for one invocation without saving. Pending requests expire after two minutes and create no agent placeholder until approval is collected. The two-digit code is only confirmation of the exact request, not a connection key or admin password. Offline identity reuse still requires the previous key; a live identity cannot be displaced. Legacy GUI-key enrollment remains explicit via `--enrollment-key` or `--key-stdin`.

The standalone server starts no local agents and automatically saves agent IDs/labels and key hashes privately under `$PIS_HOME/web-server/registrations-PORT.json`; web logins and pending approvals stay **only in memory**. History is fetched from clients, not a transcript database. Client keys are private host files under `$PIS_HOME/web-agents`, never sandbox mounts. After a standalone restart with the same storage and port, saved clients can reconnect without reapproval; log into the browser again. Existing connector/projects are not killed. Clients whose registrations were already lost before this upgrade need one fresh approved connect. See the linked guide for permissions and conservative crash-lock recovery. Normal transport loss reconnects with the saved machine key without prompt replay. GUI revocation disconnects transport, not local work; Ctrl-C in each connector terminal stops that agent. **Direct HTTP remains loopback-only; SSH forwarding is experimental and real-host verification is pending. Direct LAN/TLS and a separate Podman server remain unimplemented.** See [complete instructions, security contracts and verification limits](docs/web-agents.md).

The form sends a normal prompt while idle and **steer** while the agent works. Under **Meddelandekö**, queue editable local steer/follow-up drafts, then explicitly deliver them. **Hämta tillbaka Pi-kön** confirms and clears the whole remaining native queue into drafts for editing; already-delivered instructions cannot be recalled. Unknown deliveries are never resent automatically. Drafts belong to that agent/runtime and are lost on logout/page close. See [queue behavior and limits](docs/web-control.md#steering-and-editable-message-queues).

The header reports the selected agent's last-known **remaining context percentage** when native stats support it; otherwise **okänd**. This is context capacity, not subscription quota. Subagent tool cards distinguish a completed invocation from still-unconfirmed asynchronous work.

Standalone launched through `pis --server --standalone` now has **Serverunderhåll → Uppdatera och starta om servern**. It requires admin confirmation, a clean installation checkout, public HTTPS GitHub origin and a fast-forward; dependency/supervisor changes stay manual. Independent agents are not stopped. Reload and log in again after restart; save local drafts first. No automatic rollback or interval checks; see [limits and recovery](docs/web-control.md#manual-server-update-from-the-gui).

The agent has a spinning work indicator and explicit idle/error/unknown labels. Each correlated tool call and its literal result share one card: dashed while running, blue when completed, red on reported failure; interrupted/missing results stay unknown. Idle is not a guarantee that the task succeeded.

Assistant replies support basic Markdown: headings, emphasis, code, bullet/numbered lists, read-only task checkboxes, pipe tables and explicit `[label](https://...)` links. Links open in a new tab without opener/referrer access; images and raw HTML stay disabled. Task checkboxes are display-only, not controls for the agent.

## Development and tests

```sh
npm run check                  # Syntax checks + fast tests; no model calls
npm run demo:dummy             # Offline lorem + simulated Codex exhaustion/refill/resume
npm run test:web               # Optional local web suite, after installing web/ dependencies
npm run test:integration       # Builds and runs real rootless Podman containers
npm run test:storage           # Separate opt-in host legacy/new storage benchmark; >=10 GiB free
# Optional: real installed candidate CLI, only local fake model services:
PIS_PI_PACKAGE=/path/to/node_modules/@earendil-works/pi-coding-agent npm run test:pi-compat
# Optional: installed compatible Pi RPC state/history/shutdown, no model or network calls:
PIS_PI_PACKAGE=/path/to/node_modules/@earendil-works/pi-coding-agent npm run test:rpc-compat
```

The [offline dummy backend](docs/dummy-agent.md) speaks the same local JSONL RPC/control-view path without launching Pi or using provider credentials. It accepts test prompts such as `/dummy quota 5`, `/dummy quota hold`, `/dummy refill`, `/dummy transient` and `/dummy error`. Its automatic resumption is a simulator using the real host wait protocol, not production `--auto-wait-codex` support in RPC. The optional [local web demo](docs/web-control.md) now uses this backend; an experimental registered-Pi-project mode is available via explicit `--project`, with real-container verification still pending.

Integration tests require the runtime prerequisites plus `script` from util-linux. They use fake credentials and a local fake OpenAI upstream, make no paid/external model API requests, remove temporary containers/project data/image tags, and may leave reusable Podman build caches/base images.

Real-container coverage includes package/custom instruction builds, absolute working directories, UID/GID ownership, extra mount permissions, credential selection, persistent state, Pi startup, pipes, exit codes, PTY Bash, project exclusivity, bounded shutdown, the Unix socket proxy, Pi API-key/Codex streaming against fake upstreams, host OAuth refresh, and TypeScript extensions seeing only dummy credentials. Berget/custom profiles have fast fake-upstream route/streaming coverage but no real-container tool-round-trip coverage yet. The Codex integration runs without container networking.

## Further documentation

- [Development map, verification boundaries and remaining work](docs/development.md)
- [Local dummy web demo: setup, security and verification](docs/web-control.md)
- [Offline dummy agent and quota/resumption test messages](docs/dummy-agent.md)
- [Local RPC adapter, bounded text views and verification](docs/pi-rpc.md)
- [User-approved apt and host Git operations](docs/host-actions.md)
- [Planned host Git identity defaults](docs/git-identity-plan.md)
- [Known issues and resolved CNI warning](docs/known-issues.md)
- [GNOME Codex quota indicator](gnome-codex-usage/README.md)
- [API proxy: OpenAI, Berget, Mistral, custom profiles, and security](docs/proxy.md)
- [Berget/API-key implementation notes](docs/berget-plan.md)
- [Codex subscription sign-in and proxy](docs/codex.md)
- [Wait for Codex quota, then resume a saved task](docs/codex-wait.md)
- [Claude Code mode: setup and weaker credential boundary](docs/claude-code.md)
- [Image extension setup and remaining plans](docs/extensions-plan.md)
- [Cache-friendly shared image layers, compatibility and storage benchmark](docs/image-storage.md)
- [Managed Pi/npm updates, rollback and verification limits](docs/updates.md)
- [Pi 1.5 upgrade, watchdog compatibility and remaining update design](docs/updates-plan.md)
- [Design and configuration](docs/design.md)
- [Implementation roadmap and acceptance tests](docs/roadmap.md)

## References

- [Pi containerization guide](https://pi.dev/docs/latest/containerization)
- [Pi security guide](https://pi.dev/docs/latest/security)
- [Podman run reference](https://docs.podman.io/en/latest/markdown/podman-run.1.html)
