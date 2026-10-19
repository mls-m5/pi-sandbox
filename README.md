# pis — Pi in a Podman sandbox

`pis` is a Linux-only CLI that runs the entire [Pi coding agent](https://pi.dev) inside a rootless Podman container.

**Status: working initial implementation.** Project registration, editable configuration, custom images, additional mounts, persistent Pi state, shell/exec modes, and diagnostics are implemented. The host-side OpenAI API-key proxy is the default for new projects; ChatGPT/Codex OAuth proxy mode is also implemented. Declarative extension management is planned.

## Requirements

- Linux, running as a normal user (not root).
- Node.js 22.19 or newer.
- Local, rootless Podman with subordinate UID/GID mappings configured.
- Podman's init helper, usually supplied by the `catatonit` package.
- Network access to build the image and use model APIs.
- Vim, or another editor configured through `$VISUAL` / `$EDITOR`.

Tested on Ubuntu 24.04 with rootless Podman 4.9.3 and crun. SELinux behavior is implemented but has not yet been tested on an enforcing host.

The CLI has **no npm dependencies** and runs directly from the checkout.

If your terminal selects an older Node, check `node --version` and put a compatible Node on PATH. If Pi's bundled Node is installed at the following path, you can use it temporarily:

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

This adds the checkout's `bin/` directory to PATH in the current Bash terminal only. It does not change any shell configuration files.

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
export OPENAI_API_KEY='your-key'
pis
```

The first launch builds an image with Node, Pi, Bash, Git, ripgrep, and CA certificates. Later launches reuse it. `pis --new` registers the directory; it does not launch Pi or build the image.

By default `pis` runs **`pi --continue`**. Pi uses sandbox-local state, not your host Pi installation or configuration. New projects keep the host OpenAI key outside the container and give Pi a temporary dummy key. Existing projects retain their previous credential settings; see [enabling the proxy](docs/proxy.md#enable-it) to switch.

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

Remove any old `keyEnv` field; keep the rest of the project configuration. Then select `pis -- --model openai-codex/<model-id>`. The real access/refresh tokens remain in private host storage and refresh there automatically; Pi and extensions get only a synthetic proxy token. `pis --logout-codex` removes the shared host sign-in.

Prefer a dedicated sign-in: importing copies rotating tokens without synchronizing the original client. See [Codex setup, imports, and limitations](docs/codex.md). Live subscription sign-in is not covered by the fake-service tests.

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

Configuration includes these editable fields:

```json
{
  "image": {
    "packages": ["python3", "python3-venv", "make"],
    "extraInstructions": ["RUN npm install -g typescript"]
  },
  "mounts": [
    { "source": "/home/mattias/Prog/shared-library", "access": "read-only" },
    { "source": "/home/mattias/Data/test-fixtures", "access": "read-write" }
  ],
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

This is a partial example, not a complete replacement configuration. Keep the generated `version`, `id`, and `root` fields. Use your own canonical absolute paths. Omitted extra-mount access defaults to read-only.

Generated configuration also contains an **inert `examples` section**. Copy examples into active fields to enable them; examples themselves never share directories or execute instructions.

- Packages are Debian apt package names, optionally with versions.
- Advanced customization supports single-line `RUN` instructions only, without trailing continuations or build mounts. These are trusted executable code.
- Changes to image settings trigger a build on the next launch; mount/credential changes do not.
- Manually installed packages disappear when the container is removed.
- Credential configuration stores host environment variable **names**, never values. Proxy mode requires its host key and never falls back to exposing it. Deliberate direct mode remains available by removing `proxy` and setting `env`; those keys are visible inside the container.
- API-key mode supports Responses, Chat Completions, and model listing; Codex mode supports its separate ChatGPT Responses endpoint with host OAuth refresh. Both have optional exact model restrictions and per-run request/concurrency limits. See [proxy behavior and limitations](docs/proxy.md).

```sh
pis --check                    # Validate configuration and active paths
pis --show                     # Effective settings; no credential values
pis --build                    # Ensure the configured image exists
pis --rebuild                  # Rebuild without cached build steps
```

The Node base image is digest-pinned and Pi is pinned to 1.2.0. apt repositories and npm transitive dependencies are not fully locked, so uncached builds are not guaranteed to be bit-for-bit reproducible. Updating pinned versions currently requires a source change in `src/container.js`.

## Extensions

Pi extensions already run inside the sandbox:

```sh
pis -- -e ./tools/my-extension.ts
pis -- install npm:@example/pi-tools@1.2.3  # Replace with an actual trusted package
pis -- list
```

Local files must already be available through the project or an explicit extra mount. Package installs persist in this project's Pi state, not your host Pi installation. Extensions see only the proxy dummy key/token, but can use it for permitted requests.

See [the extension support plan](docs/extensions-plan.md) for current usage and proposed declarative project configuration, pinned package synchronization, and trust rules. The proposed configuration fields and management commands are not implemented yet.

## Storage

Default: `~/.local/share/pis/`. Override with `$PIS_HOME`, or `$XDG_DATA_HOME/pis` when `PIS_HOME` is unset. Overrides must be absolute.

```text
~/.local/share/pis/
  index.json                    # Rebuildable cache; configs are authoritative
  auth/openai-codex.json         # Private host OAuth credentials; NEVER mounted
  projects/k7m2q/
    project.json
    Containerfile               # Generated; do not edit
    build/Containerfile         # Minimal build context, no source or credentials
    state/                      # Persistent sandbox home and Pi state
```

Host Pi state at `~/.pi/agent` is not mounted. Conversations are stored in the project's sandbox state, with a shared session directory across invocation subdirectories. Pi still uses the invocation working directory for its own context/resource discovery.

Only one build or running container per registered project is allowed at a time. Separate projects can run concurrently. Registry updates are also locked; conflicting edits are rejected rather than silently overwriting changes.

If a process is forcibly killed or the machine crashes, a lock may remain. The error reports its path. Inspect the PID recorded in the lock and check for associated `pis-<project-id>-...` containers before manually removing a stale lock. Locks are deliberately not automatically stolen.

No project deletion or image garbage-collection command exists yet. Do not edit or delete state/configuration while its project is running. Old generated image tags can accumulate when image configuration changes.

## Security boundary

- Project and extra mounts preserve their absolute host paths, supporting file links.
- The project is read-write; explicitly shared directories default to read-only.
- Containers run with the invoking user's UID/GID, dropped capabilities, `no-new-privileges`, default seccomp, and a container init process.
- Host home, host Pi configuration, SSH agents, and container sockets are not automatically shared.
- Wrapper configuration is outside repositories; repositories cannot silently add wrapper mounts.
- On SELinux hosts, project/extra mounts use shared labels (`:z`) and state uses a private label (`:Z`). Relabeling changes host filesystem labels and may affect other applications.

**A writable mount permits Pi to change or delete those host files.** Secrets already in mounted directories, including `.env` files, remain accessible. Symlinks do not grant access to unmounted external targets. Resource limits are not configured yet.

**Proxy mode keeps the host-provided API key or Codex OAuth tokens outside the sandbox**, using a private Unix socket and a per-run dummy capability. No host TCP port is opened. Pi's selected provider auth/model entries are replaced with read-only per-run overlays; originals are unchanged. Direct-mode forwarded keys, other stored credentials, or secrets in mounted files remain visible. The proxy does not retroactively scrub old state.

Hiding keys does not prevent API spending: sandboxed commands and extensions can use the capability within its host-enforced route/model/request limits. Outbound networking remains enabled; this is not a host/LAN access filter or exfiltration defense. Containers share the host kernel, not a VM-level boundary. Custom build instructions are trusted code; runtime keys and source are not supplied to builds. See [the proxy security notes](docs/proxy.md#security-boundaries-and-limitations).

## Development and tests

```sh
npm run check                  # Syntax checks + fast tests; no model calls
npm run test:integration       # Builds and runs real rootless Podman containers
```

Integration tests require the runtime prerequisites plus `script` from util-linux. They use fake credentials and a local fake OpenAI upstream, make no paid/external model API requests, remove temporary containers/project data/image tags, and may leave reusable Podman build caches/base images.

Real-container coverage includes package/custom instruction builds, absolute working directories, UID/GID ownership, extra mount permissions, credential selection, persistent state, Pi startup, pipes, exit codes, PTY Bash, project exclusivity, bounded shutdown, the Unix socket proxy, Pi API-key/Codex streaming against fake upstreams, host OAuth refresh, and TypeScript extensions seeing only dummy credentials. The Codex integration runs without container networking.

## Further documentation

- [OpenAI proxy: setup and security](docs/proxy.md)
- [Codex subscription sign-in and proxy](docs/codex.md)
- [Extension usage and implementation plan](docs/extensions-plan.md)
- [Design and configuration](docs/design.md)
- [Implementation roadmap and acceptance tests](docs/roadmap.md)

## References

- [Pi containerization guide](https://pi.dev/docs/latest/containerization)
- [Pi security guide](https://pi.dev/docs/latest/security)
- [Podman run reference](https://docs.podman.io/en/latest/markdown/podman-run.1.html)
