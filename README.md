# pis — Pi in a Podman sandbox

`pis` is a Linux-only CLI that runs the entire [Pi coding agent](https://pi.dev) inside a rootless Podman container.

**Status: working initial implementation.** Project registration, editable configuration, custom images, additional mounts, persistent Pi state, shell/exec modes, and diagnostics are implemented. The credential proxy is planned, not implemented.

## Requirements

- Linux, running as a normal user (not root).
- Node.js 22.19 or newer.
- Local, rootless Podman with subordinate UID/GID mappings configured.
- Podman's init helper, usually supplied by the `catatonit` package.
- Network access to build the image and use model APIs.
- Vim, or another editor configured through `$VISUAL` / `$EDITOR`.

Tested on Ubuntu 24.04 with rootless Podman 4.9.3 and crun. SELinux behavior is implemented but has not yet been tested on an enforcing host.

The CLI has **no npm dependencies** and runs directly from the checkout.

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

By default `pis` runs **`pi --continue`**. Pi uses sandbox-local state, not your host Pi installation or configuration.

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
    "env": ["OPENAI_API_KEY"]
  }
}
```

This is a partial example, not a complete replacement configuration. Keep the generated `version`, `id`, and `root` fields. Use your own canonical absolute paths. Omitted extra-mount access defaults to read-only.

Generated configuration also contains an **inert `examples` section**. Copy examples into active fields to enable them; examples themselves never share directories or execute instructions.

- Packages are Debian apt package names, optionally with versions.
- Advanced customization supports single-line `RUN` instructions only, without trailing continuations or build mounts. These are trusted executable code.
- Changes to image settings trigger a build on the next launch; mount/credential changes do not.
- Manually installed packages disappear when the container is removed.
- Credentials are environment variable **names**, never values. Missing values are warned about when launching Pi, allowing sandbox-local login as an alternative.

```sh
pis --check                    # Validate configuration and active paths
pis --show                     # Effective settings; no credential values
pis --build                    # Ensure the configured image exists
pis --rebuild                  # Rebuild without cached build steps
```

The Node base image is digest-pinned and Pi is pinned to 1.2.0. apt repositories and npm transitive dependencies are not fully locked, so uncached builds are not guaranteed to be bit-for-bit reproducible. Updating pinned versions currently requires a source change in `src/container.js`.

## Storage

Default: `~/.local/share/pis/`. Override with `$PIS_HOME`, or `$XDG_DATA_HOME/pis` when `PIS_HOME` is unset. Overrides must be absolute.

```text
~/.local/share/pis/
  index.json                    # Rebuildable cache; configs are authoritative
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

**Selected API keys are visible to processes inside the sandbox.** Outbound networking is enabled and is not a host/LAN access filter or exfiltration defense. Containers share the host kernel, not a VM-level boundary. Custom build instructions are trusted code and may access the network; runtime provider keys and project source are not supplied to the build.

A future host-side OpenAI proxy will accept dummy keys and substitute real credentials. It is not available yet, and hiding keys alone will not prevent API spending by sandboxed processes.

## Development and tests

```sh
npm run check                  # Syntax checks + fast tests; no model calls
npm run test:integration       # Builds and runs real rootless Podman containers
```

Integration tests require the runtime prerequisites plus `script` from util-linux. They use dummy credentials, make no model API requests, remove their temporary containers/project data/image tag, and may leave reusable Podman build caches/base images.

Real-container coverage includes package/custom instruction builds, absolute working directories, UID/GID ownership, extra mount permissions, credential selection, persistent state, Pi startup, piped input, exit codes, interactive Bash via a PTY, project exclusivity, and bounded termination of an uncooperative process.

## Further documentation

- [Design and configuration](docs/design.md)
- [Implementation roadmap and acceptance tests](docs/roadmap.md)

## References

- [Pi containerization guide](https://pi.dev/docs/latest/containerization)
- [Pi security guide](https://pi.dev/docs/latest/security)
- [Podman run reference](https://docs.podman.io/en/latest/markdown/podman-run.1.html)
