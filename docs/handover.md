# Development handover: continuing inside the sandbox

This file summarizes the recent design decisions and operational context. Start here, then use the linked feature documents and code as the source of truth. Instructions below distinguish repository features from host-local setup; the latter is not available merely because this repository is mounted in a container.

## Current implementation

### Startup, defaults and models

- `pis` wraps pinned Pi 1.2.0 in rootless Podman. Host Node must be >=22.19; container base is pinned Node 24.
- Default Pi invocation: `pi --tui-mode regular --continue`. `--fresh` removes implicit continuation; explicit TUI/session options override defaults. Management subcommands do not receive these defaults.
- New projects use the **openai-codex host OAuth proxy**, not the paid OpenAI API-key route. Existing explicit configurations are preserved, not migrated automatically.
- An empty proxy `models` list allows any model through that provider. The user can start `pis` and choose `/model`; a model CLI argument is not required. A saved/continued session may restore a previously selected model.
- New project `image.packages` defaults: `build-essential`, `python3`. Existing lists, including explicit `[]`, remain unchanged.
- Interactive startup logs elapsed times for image readiness, proxy preparation, container startup and Pi/session/extension loading. These are stage timings, **not** a reliable remaining-time estimate. They are kept out of default noninteractive/custom-stdio protocol runs.
- `project.json` accepts `//` and `/* ... */` comments. Normalization/edit-save can remove them. This is comment support, not preservation or full JSON5/trailing-comma support.

### Credentials and spending

- `pis --login-codex`, import and logout are already **global per PIS_HOME**. There is no separate `--global` flag and no per-project Codex login. Default store: `~/.local/share/pis/auth/openai-codex.json`.
- Real OAuth/API credentials remain on the host. Per-run sandbox auth/model overlays contain dummy capabilities, not usable upstream credentials. Do not run `/login` inside a proxied sandbox.
- API-key profiles support OpenAI, Berget, Mistral and custom endpoints. `pis --login-mistral` / `--logout-mistral` are aliases for the Mistral profile flow. In project config use `provider: "mistral", profile: "mistral"`, without `keyEnv`, and `credentials.env: []`.
- Mistral proxy uses native Pi Mistral Chat Completions at `/v1/chat/completions`; its Pi base URL is the local origin, **without /v1**, because Pi appends that path. Mistral subscription/browser authentication is **not implemented**.
- OpenAI API keys and Codex subscription login are separate. The user accidentally spent API credits on the wrong model and deferred signing out. Do not alter/revoke credentials without a fresh request. Model allowlists can restrict accidental selection; proxy request counts are not monetary/token budgets.
- `pis --codex-usage` is host-only, refreshes OAuth as needed and prints sanitized numeric quota windows. Usage API returns **used** percentage; remaining is `100 - used_percent`. Its real-account retrieval worked during this work.

See [Codex](codex.md), [proxy setup](proxy.md), and [README](../README.md).

### Host approval tools

Built-in, image-owned extension: `src/runtime/request-apt.mjs`. Host proposal service: `src/apt-requests.js`. Despite the historical filenames and `PIS_APT_SOCKET` environment name, this service now handles **typed apt and Git proposals**.

- Available only in ordinary interactive Pi launches with persisted sessions. Not exposed in print/JSON/RPC, `--no-session`, custom stdio, `--bash`/`--exec`; `--no-extensions` suppresses the extension.
- Only one proposal is accepted per container run. No approval field, shell command or arbitrary host operation can cross this interface.
- Pi stops; pis confirms the container is gone and closes its sockets before asking on the **host terminal**.
- Prompt UI: full-width red divider, bold heading, highlighted values, **two-digit random confirmation code**. Enter or any other answer declines. Color is terminal-only and respects `NO_COLOR` / `TERM=dumb`.
- The short code is an accidental-approval safeguard, not a strong authentication secret. Sandbox explanations are untrusted. Do not claim protection from every terminal-emulator attack or a compromised host/kernel.
- After a successful approved action, Pi automatically restarts with the latest session. The original prompt and one-off CLI options are not replayed.
- A single **English user message** reports the completed action and asks the agent to continue. This triggers a model turn and **uses tokens**. Normal later launches do not repeat it. The notice is in-memory; a failed restart does not persist a delivery queue for a later manual launch.

`request_apt_packages`:

- Only bounded simple Debian package names and a reason; not npm packages, arbitrary `RUN` instructions or versioned package requests.
- Approval adds packages atomically to `image.packages`, refuses stale configuration, rebuilds, then resumes and notifies the agent. Decline leaves config unchanged and does not restart.

`request_host_git`:

- General tool envelope: relative `repo`, one `args` array without `git`, and `reason`.
- **Only push is implemented/allowlisted**, in the form `["push", "origin", "FULL_40_HEX_COMMIT:refs/heads/main"]`. No force, aliases, shell syntax, multiple commands, implicit HEAD or arbitrary Git subcommands.
- Push actually executes **on the host** after independent approval showing resolved URL, full commit and destination branch.
- Host code snapshots object data to a fresh private bare repo, validates object integrity and pushes that exact commit. It never runs Git in the shared repo or inherits its hooks/configuration/helpers/URL rewrites.
- SSH uses host agent/default keys plus `known_hosts`, with strict checking and SSH config/proxies/local commands disabled. Custom `~/.ssh/config` aliases/identities are not used. HTTPS may request username/token in the host terminal; stored Git credential helpers are deliberately disabled.
- First-version limits: ordinary SHA-1 `.git` directories, complete object data, <=2 GiB / 100000 object files, standard-port SSH/HTTPS. No worktree/submodule `.git` files, file/ext helpers or other transports.
- Failure does not trigger a success notice or automatically retry the push. Never bypass these restrictions by handing arbitrary shell/Git strings to the host.

Details and trust limits: [Host actions](host-actions.md). Implementation: `src/git-push.js`, restart loop in `src/container.js`.

### Image cleanup and disk space

- Container launches already use `--rm`; images/build caches are separate and can accumulate after configuration/source changes.
- `pis --prune --dry-run` previews; `pis --prune` explicitly removes eligible old image tags.
- Automatic pruning is **enabled by default** after successful image builds, in a detached host worker. It retries after the built session releases its project lock. Successful complete passes are throttled to once per day; busy/failed passes may retry earlier. `PIS_AUTO_PRUNE=0` disables automatic scheduling.
- Only fingerprint-tagged `localhost/pis-<registered id>:<hash>` images in this PIS_HOME are eligible. Keep configured image + one recent other version, or two existing versions if configured image is not built. Keep <24h images, used images and images with other repository/project tags. Busy projects are skipped.
- Locks serialize cleanup with builds/sessions and config edits; deletion rechecks eligibility, never forces, and uses `rmi --no-prune` to avoid recursively deleting parent layers.
- Does not clean arbitrary Podman images, untagged cache layers, Buildah workspaces, volumes or sandbox/project state. `prune-report.json` in PIS_HOME contains the last automatic result.
- Host disk inspection found images/layers, not stopped run containers, dominated Podman usage. Persistent pis state also contains intentional tooling (including an Emscripten SDK); do not delete it as cache.
- Buildah containers are build workspaces. They can be active even though absent from ordinary `podman ps`. Manual `buildah rm --all` is only appropriate when no builds are running and the user does not need those workspaces. Automatic Buildah cleanup was intentionally excluded.

See README's [image cleanup](../README.md#image-cleanup), `src/prune.js` and `src/prune-worker.js`.

### GNOME quota indicator

- Separate host subproject: [gnome-codex-usage](../gnome-codex-usage/README.md). GNOME 46 was present on this host; metadata currently lists Shell 45–48.
- Calls `~/.local/bin/pis --codex-usage` directly, because GNOME did not inherit the terminal's PATH. Does not read OAuth files itself.
- Shows remaining quota percentages plus reset countdowns: hours/minutes for the short window (not necessarily daily), days/hours for weekly. Fetches every five minutes, redraws the cached countdown every minute and has manual Refresh. `usage-format.js` contains offline-tested pure time/percentage helpers and must be installed alongside `extension.js`. GNOME installation is a copy: editing repository files does not update the installed extension automatically.
- `pi-usage-bar-focus` was removed from defaults because its Codex percentages did not work reliably. The only default npm Pi extension now is `pi-web-access@0.40.0`. Existing explicit arrays are not globally rewritten.
- Host GNOME extension was installed and user extensions enabled. Full graphical lifecycle/error handling still needs manual verification; no GJS runtime test was available during initial development.

## Host-local changes (not portable repository configuration)

- Checkout used here: `/home/mattias/Prog/Experiment/pi-sandbox2`. An older `/home/mattias/Prog/Experiment/pi-sandbox/bin/pis` also appeared on PATH. Use the intended checkout, not whichever `pis` happens to resolve first.
- `~/.local/bin/pis` on this host is now a small executable launcher, **not a symlink**. It explicitly executes `~/.local/share/pi-node/current/bin/node` with this checkout's `bin/pis.js`.
- This avoided old Node 18 at `~/.local/bin/node` and Node 12 at `/usr/bin/node`. `env.sh` also prefers the bundled Node when present, but only changes the shell in which it is sourced.
- A host `~/.config/environment.d/50-pis.conf` was created; GNOME still did not inherit that PATH in the tested session. The extension's explicit launcher path is the actual workaround.
- No host credential contents belong in this file or repository. Do not dump environment/auth files to diagnose PATH or login problems.

## Resolved warning: missing CNI dnsname

A `draftv2-net-…` network configuration from a separate PHP/MariaDB note-editor project caused Podman startup warnings. Logs confirmed host `apt autoremove` removed its dnsname plugin on 2026-11-05 at 12:20:11; this was **not an autoprompt/proxy bug**.

The user no longer used that test network. After checking no containers referenced it, its config was archived outside active CNI config. Direct Podman network/container tests then succeeded without warnings; user confirmed startup worked. No packages, database volumes or running containers were deleted.

Exact backup location, diagnosis and restoration instructions: [Known issues](known-issues.md). Do not reinstall packages or change network backends just to hide an already resolved warning.

## Remaining requested work

1. **Git identity defaults — requested, not implemented.** Read only host-global `user.name` and `user.email` and initialize missing sandbox values, preserving explicit choices. Never copy all of `.gitconfig`. See [Git identity plan](git-identity-plan.md).
2. Mistral subscription authentication is a future wish; no supported auth protocol was selected or implemented. API-key login works independently.
3. Broader host Git subcommands may be added to the generic tool only with per-operation validation. A single `git` process is not intrinsically safe: helpers, hooks, filters and configuration can execute code.
4. Verify full interactive shutdown/approval/rebuild/resume behavior in a real container, especially failures, multiple tool calls and selected/branched sessions. Current automatic restart targets the latest session, not an explicit captured session ID.
5. Verify host SSH/HTTPS push authentication interactively, including non-fast-forward rejection. The real transfer test is local/offline; no external remote was pushed during development.
6. Check graphical GNOME enable/disable/refresh behavior, stale data and failure presentation.
7. Continue conservative cleanup testing across concurrent launches/edits; never broaden pruning to host data or Buildah workspaces silently.

## Verification and working inside a container

```sh
npm run check             # Syntax + fast tests; no paid model calls
npm run test:integration  # Opt-in rootless Podman builds/runs against fake services
```

Latest check after the documentation/countdown work: **88 tests: 84 passed, 4 skipped**. The skipped suites need real Podman; availability inside a sandbox is not assumed. The Git tests include a real local bare-repo transfer with a test-only file transport substitution, not external credentials/network pushes. Mistral live model access, host SSH auth and complete interactive approvals were not verified end-to-end.

Inside a normal sandbox you can read/edit the shared checkout and run fast tests. You do **not** have host project.json, credentials, GNOME Shell or Podman control access. Use the image-owned approval tools to request supported host actions; if they are unavailable, ask the user to restart the host wrapper with an updated image or perform the step in a host terminal. Do not mount host home, SSH agents or Podman sockets to bypass this boundary.

Recent implementation commits (before this documentation pass):

- `4ce8176`: approved host Git push and post-action continuation.
- `493049f`: CNI diagnosis and archived-network resolution notes.
- Earlier: `52a609d` pruning, `cc9ab1f` approval styling/restart, `c214c52` startup stages.

Use `git status` and `git log` for current state rather than assuming this document's commit list is exhaustive. The host session history is not automatically the sandbox Pi conversation; this file is the intended handover context.
