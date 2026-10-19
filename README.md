# pis — Pi in a Podman sandbox

`pis` is a planned Linux-only CLI wrapper that runs the entire [Pi coding agent](https://pi.dev) inside a rootless Podman container.

**Status: design stage. No implementation exists yet.** Commands below describe the intended interface.

## Goals

- Let Pi edit a registered project without exposing the rest of the host filesystem.
- Preserve absolute filesystem paths so file links in terminal output remain useful.
- Run containers with the invoking user's UID and GID.
- Keep configuration, generated build files, and Pi state in the user's home directory, separately for each project.
- Allow explicit, project-specific sharing of additional directories.
- Customize installed development tools through JSON configuration.
- Continue the previous Pi conversation by default.
- Eventually keep real OpenAI API keys outside the sandbox using a credential-injecting proxy.

## Intended usage

```sh
cd ~/Prog/my-app
pis --new --name my-app        # Register this directory as a project
pis --edit                    # Edit and validate its configuration
pis                           # Run pi --continue
pis -- --model <model-id>      # Continue with additional Pi arguments
pis --fresh                   # Start Pi without --continue
pis --fresh -- -p "Run tests"  # Start a fresh noninteractive task
pis --bash                    # Open an interactive shell in the sandbox
pis --exec -- python3 -m pytest
```

Additional management commands:

```sh
pis --list
pis --project k7m2q
pis --project my-app
pis --check
pis --show
pis --build
pis --rebuild
pis --doctor
pis --relocate k7m2q
```

### Project discovery

Projects are explicitly registered, not inferred from Git repositories.

- `pis --new` registers the current directory, assigning a random five-character ID and an optional friendly name.
- Normal startup uses the nearest registered project at or above the current directory.
- If no project exists, `pis` complains and suggests `pis --new`; it does not silently create one.
- Starting in a subdirectory mounts the registered project root but starts Pi in that subdirectory.
- Nested projects exist only when explicitly registered with `pis --new`.
- Selecting a project by name or ID from outside its directory starts at its root.

## Filesystem access

A project at `/home/mattias/Prog/my-app` is mounted at `/home/mattias/Prog/my-app` inside the container, not at `/workspace`. Additional shared directories also preserve their host paths.

The project mount is read-write. Extra directories are only mounted when explicitly configured, with read-only access as the default. Host home, host Pi configuration, SSH agents, and container sockets are not automatically shared.

A writable mount permits Pi to change or delete those host files. Credentials and secrets within mounted directories remain accessible. Containers share the host kernel and are not a VM-level security boundary.

## Documentation

- [Design and configuration](docs/design.md)
- [Implementation roadmap and acceptance tests](docs/roadmap.md)

## References

- [Pi containerization guide](https://pi.dev/docs/latest/containerization)
- [Pi security guide](https://pi.dev/docs/latest/security)
- [Podman run reference](https://docs.podman.io/en/latest/markdown/podman-run.1.html)
