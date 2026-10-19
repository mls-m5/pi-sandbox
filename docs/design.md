# Design

This document records the agreed direction for `pis`. It describes intended behavior, not an existing implementation. Details marked open need to be settled during implementation.

## 1. Scope and architecture

Build a Linux-only host CLI that launches the entire Pi process in rootless Podman. Pi extensions, tools, shell commands, and child processes run inside the container, rather than delegating only selected tools from a host Pi process.

Proposed implementation language: TypeScript, with a small dependency footprint. Pi SDK integration is not needed for the initial wrapper.

```text
Host pis CLI
  ├─ Discover registered project
  ├─ Load and validate host-managed configuration
  ├─ Ensure generated project image exists
  ├─ Resolve mounts, identity, credentials, and working directory
  └─ Launch Podman with an argument array, never an interpolated shell command
       └─ Pi, Bash, or an explicitly selected program
```

Containers are disposable. Project files and per-project Pi state persist.

## 2. Project identity and discovery

A project has:

- A random five-character ID, generated with collision checking.
- An optional unique friendly name.
- A canonical absolute root directory.
- Its configuration, generated image inputs, and persistent Pi state.

A project is not a Pi conversation. Multiple Pi conversations can belong to the same project.

### Registration

`pis --new` registers the current canonical directory. `--name NAME` assigns a friendly name. Registration at an already registered root fails clearly rather than replacing its state.

Registration does not search for a Git root. A directory inside another project can be registered explicitly, creating a nested project.

### Normal discovery

1. Canonicalize the current directory, resolving symlinks.
2. Find registered roots equal to or containing that directory.
3. Select the nearest matching ancestor.
4. Fail with guidance to run `pis --new` if no root matches.

Path ancestry must be checked by path components, not naive string prefixes: `/work/app` must not match `/work/application`.

When discovered from a subdirectory, mount the project root and retain the invocation directory as the container working directory. This grants access to the registered root, not just the invocation subdirectory.

### Explicit selection and relocation

`pis --project ID_OR_NAME` selects a project without depending on directory discovery. Preserve the invocation directory when it is inside the selected root; otherwise start at the project root.

`pis --list` displays IDs, names, and roots.

`pis --relocate ID_OR_NAME` explicitly updates an existing project's root to the current canonical directory, preserving its ID and state. Do not guess identity or create a replacement when a root disappears. Relocation must check for root conflicts; absolute additional mounts are not silently rewritten.

## 3. Host storage

Initial default layout:

```text
~/.local/share/pis/
  index.json
  projects/
    k7m2q/
      project.json
      Containerfile
      build/
      state/
```

- `project.json` is authoritative.
- `index.json` is a rebuildable lookup cache for roots, IDs, and names.
- `Containerfile` is generated and marked as such.
- `build/` contains only the generated, minimal build context.
- `state/` holds container-local Pi settings, credentials saved by Pi, and conversations.

Keep these directories private to the user. Writes to configuration and index files should be atomic. Registration and index changes need locking to avoid concurrent corruption.

Host `~/.pi/agent` is never automatically mounted. The container uses a separate home/state location, outside host project paths. The precise container home path and ownership initialization are implementation details to verify with rootless Podman.

Open: whether to support XDG overrides immediately or keep a single initial storage root. The layout above is the agreed initial default.

## 4. Project configuration

Proposed active configuration:

```json
{
  "version": 1,
  "id": "k7m2q",
  "name": "my-app",
  "root": "/home/mattias/Prog/my-app",
  "image": {
    "packages": [
      "python3",
      "python3-venv",
      "make"
    ],
    "extraInstructions": []
  },
  "mounts": [],
  "credentials": {
    "env": ["OPENAI_API_KEY"]
  },
  "examples": {
    "mounts": [
      {
        "source": "/home/mattias/Prog/shared-library",
        "access": "read-only"
      },
      {
        "source": "/home/mattias/Data/test-fixtures",
        "access": "read-write"
      }
    ],
    "extraInstructions": [
      "RUN npm install -g typescript"
    ]
  }
}
```

Generated examples should use appropriate sample paths, not assume this particular host username. JSON has no comments, so `examples` is a documented, inert section: none of its contents creates mounts or executes build steps. Copy entries into active fields to enable them.

Configuration lives outside repositories so a checkout cannot silently grant itself additional host access. Do not automatically load a repository-local `pis` configuration.

### Mounts

- The project root is always mounted read-write at the identical absolute path.
- Additional `source` directories are mounted at their identical absolute paths.
- Omitted `access` defaults to `read-only`.
- Extra mounts apply only to the selected project.
- Resolve and validate paths before invoking Podman; do not execute shell expansions.
- Reject missing sources, duplicate or overlapping mount definitions, and collisions with container-managed locations.
- Reject excessively broad sources such as `/` or the entire invoking user's home directory.
- Do not use recursive ownership-changing mount options on host project data.
- Handle SELinux labels deliberately without disabling container separation globally.

A symlink inside the project does not itself expose an external target. Its target must also be available inside the container. Files already inside a shared directory, including `.env` and Git metadata, are accessible to Pi. External Git worktree metadata may require an additional explicit mount.

### Validation

Validate JSON syntax, schema version, unknown fields, field types, identity fields, root consistency, package names, environment variable names, and mount rules. Validate active paths for existence and suitability. Example paths need not exist.

Keep wrapper identity fields (`id` and `root`) protected from accidental edits; root changes should go through relocation. Do not accept arbitrary Podman arguments from configuration.

### Editing

`pis --edit`:

1. Resolve the selected project.
2. Create a temporary draft of its configuration, including examples when needed.
3. Open the draft using `$VISUAL`, then `$EDITOR`, falling back to `vim`.
4. Validate after the editor exits successfully.
5. Atomically replace the saved configuration only when valid.
6. On validation failure, offer to reopen or discard the draft; retain the previous valid configuration.

Configuration editing requires a registered project. `pis --new` creates the initial configuration; `--edit` does not implicitly register a directory.

`pis --check` validates without launching a container. `pis --show` displays effective configuration and planned mounts, never credential values.

## 5. Image generation and packages

Use a pinned base image and pinned Pi version. The base image should provide Node, Bash, Git, ripgrep, and CA certificates. Start with a Debian-based image and an apt package list.

`image.packages` installs additional OS packages during image creation. Validate package entries and handle them as data, not shell fragments.

`image.extraInstructions` supports advanced Containerfile customization, for example:

```json
{
  "extraInstructions": [
    "RUN npm install -g typescript"
  ]
}
```

These are trusted executable build instructions, not a security-restricted package format. Insert them in a defined customization section before wrapper-controlled final runtime instructions. The wrapper owns the final entrypoint, working-directory behavior, and runtime user selection. Exact supported instruction restrictions remain to be specified; a simple denylist is not a security boundary.

Build context must not include project files, persistent state, API keys, or the entire project configuration directory. Never pass runtime credentials as build arguments or build environment by default.

### Build lifecycle

Before launching a project:

1. Validate configuration.
2. Generate the Containerfile and minimal build context.
3. Fingerprint the template version, pinned dependencies, image configuration, and generated build inputs.
4. Reuse the matching image if available; otherwise build it.

Mount and credential changes do not trigger image rebuilds. Package and custom instruction changes do. Build failure must stop startup rather than silently running an outdated environment.

`pis --build` ensures the image exists. `pis --rebuild` explicitly forces rebuilding; exact cache-refresh semantics must be documented during implementation.

Packages installed manually in a disposable running container do not persist. Add permanent tools to configuration.

## 6. Runtime and command interface

| Command | Intended behavior |
| --- | --- |
| `pis` | Run `pi --continue` |
| `pis -- PI_ARGS...` | Run Pi with forwarded arguments and default continuation |
| `pis --fresh` | Run Pi without implicit `--continue` |
| `pis --fresh -- PI_ARGS...` | Run Pi with forwarded arguments and no implicit continuation |
| `pis --bash` | Open interactive Bash instead of Pi |
| `pis --exec -- PROGRAM ARGS...` | Run another program directly |
| `pis --new [--name NAME]` | Register the current directory |
| `pis --project ID_OR_NAME` | Select a registered project |
| `pis --list` | List projects |
| `pis --edit` | Edit and validate project JSON |
| `pis --check` | Validate project configuration and paths |
| `pis --show` | Show effective settings without secret values |
| `pis --build` | Ensure the project image exists |
| `pis --rebuild` | Force an image rebuild |
| `pis --doctor` | Diagnose rootless Podman and host prerequisites |
| `pis --relocate ID_OR_NAME` | Associate an existing project with the current directory |

Explicit Pi session-selection options should suppress implicit `--continue`. Verify the supported Pi version's CLI options and argument forms before implementing this detection. Forward Pi arguments unchanged otherwise.

`--fresh` starts a conversation; `--new` creates a registered project. They must not be confused.

Bash and exec modes use the same project image, mounts, identity, credentials, state, and working-directory rules as Pi mode. No extra permissions are granted.

Arguments are passed as an array, without implicit shell interpretation. Shell syntax is explicit:

```sh
pis --exec -- bash -lc 'make test && git diff'
```

Use a terminal only for interactive invocations. Piped/noninteractive usage must preserve stdin, stdout, stderr, signals, and exit status without forcing a TTY. Mutually exclusive launch and management options should produce helpful errors.

## 7. Isolation and credentials

Baseline runtime:

- Rootless Podman only; no automatic sudo fallback.
- Current UID/GID via `--userns=keep-id`, with writable state initialized correctly.
- Drop Linux capabilities and set `no-new-privileges`.
- Keep default seccomp and SELinux protections.
- No host PID/network namespace, privileged mode, host container socket, or automatic SSH agent sharing.
- Mount only the registered root, approved additional directories, and required sandbox state.

Verify support and practical behavior on the target Linux system rather than assuming identical Podman versions or cgroup capabilities.

### Initial API-key handling

Pass only explicitly selected provider environment variables, initially `OPENAI_API_KEY`. Configuration stores variable names, never their values. Missing required credentials should produce clear diagnostics without printing values. Avoid logging credentials in commands or diagnostic output.

These keys are accessible to Pi and other processes inside the container. Per-project state can also contain sensitive credentials and transcripts. This first version does not provide a credential boundary against sandboxed commands.

### Future OpenAI credential proxy

```text
Sandbox Pi with dummy key
  → host-managed proxy
  → real OpenAI credential inserted by proxy
  → fixed OpenAI upstream
```

The real key remains outside the container. The proxy should restrict upstreams and endpoints, redact authentication from logs, handle streaming correctly, and avoid becoming an open forwarding proxy. Endpoint configuration must work with Pi's provider configuration.

Dummy keys do not prevent API use or spending by sandboxed commands. Add authentication/scoping, quotas, and network restrictions as needed. Reachability from the sandbox must not require broadly exposing unrelated host services.

### Network limitations

The initial runtime allows outbound networking for model APIs and development workflows. Default Podman networking is not a destination allowlist and can permit access to host or LAN services. Do not advertise network isolation or exfiltration prevention.

Stronger egress controls, host/LAN restrictions, and proxy-only access are a separate tested milestone.

## 8. Open implementation decisions

- Exact pinned Pi and base image versions, update workflow, and supported Podman versions.
- Container home/state paths and safe UID/GID initialization.
- SELinux handling for projects shared by multiple concurrent containers.
- Concurrent Pi invocations and state locking policy.
- Fine-grained mount overlap policy and protection of reserved container paths.
- Supported custom Containerfile instruction contract.
- Resource-limit defaults and read-only root filesystem feasibility.
- Project deletion, image cleanup, and state-retention commands; these must never delete project source files accidentally.
- XDG overrides and configuration schema migration strategy.
