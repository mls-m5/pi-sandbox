# Implementation roadmap

The core program is implemented. Continue development in small, tested commits.

## Current progress

- **Milestones 1–3:** core functionality implemented and covered by fast tests plus an opt-in real-Podman integration test.
- **Milestone 4:** rootless diagnostics, baseline privilege restrictions, per-project exclusivity, bounded shutdown, and crash-lock guidance implemented. Resource limits, read-only root, broader compatibility testing, safe deletion/cleanup, and migration/update workflows remain.
- **Milestone 5:** OpenAI, Berget, and host-profile custom API-key proxies plus Codex OAuth implemented with private Unix sockets, per-run dummy capabilities, route/model restrictions, request/concurrency limits, streaming, and cancellation. Custom destinations are host-managed, HTTPS-only, pinned to validated public DNS addresses, and initially limited to Chat Completions. Codex includes host sign-in/import, private storage, serialized token refresh, synthetic JWTs, and bounded zstd decoding. Monetary quotas and proxy-only egress remain future work.
- **Extensions:** npm install sources in JSON, default usage/web packages, build-time Pi installation, automatic loading (including Bash), configuration defaults/hints, and a generated editor schema are implemented. Git/local build sources and advanced dependency/update reconciliation remain [future work](extensions-plan.md).
- **Verification:** tested on Ubuntu 24.04, Podman 4.9.3, crun, and cgroups v2. Real-container tests cover identity, mount permissions, custom builds, credentials, state, Pi startup, pipes, exit codes, PTY Bash, concurrent-use rejection, and SIGTERM cleanup. Actual Pi API-key and Codex streamed conversations and explicit TypeScript extensions are tested against local fake services, including host OAuth refresh, image-baked default packages, a real web-search tool roundtrip, and sanitized usage retrieval with container networking disabled; no external/paid model API calls are made. Host API-key profile storage, custom URL validation, path-prefix routing, and fake Berget/custom upstream behavior have fast tests. Live Berget/custom provider compatibility and real-container Berget/custom streaming/tool calls remain to be tested. SELinux-enforcing behavior also needs verification.

The sections below retain the full milestone checklist, including acceptance goals that extend beyond current coverage.

## Milestone 1: Project registry and configuration

- Set up the CLI and automated tests (implemented using dependency-free Node.js ES modules).
- Implement private host storage and versioned configuration validation.
- Generate collision-checked five-character IDs and optional unique names.
- Implement `--new`, `--list`, `--project`, and nearest-ancestor discovery.
- Implement atomic writes, registry locking, and index rebuilding.
- Implement generated examples, `--check`, and redacted `--show`.
- Implement `--edit` with editor selection, draft validation, and recovery.
- Implement explicit relocation without losing project state.

Acceptance tests:

- An unregistered directory fails with a useful registration hint.
- A registered root and its descendants resolve to the same project.
- A sibling or similarly prefixed directory does not match.
- Nested registration is explicit and the closest registered root wins.
- Canonical paths prevent duplicate registration through symlink aliases.
- Duplicate names, ID collisions, and conflicting relocations are handled safely.
- Invalid edits do not overwrite valid configuration.
- Example mounts remain inactive.
- Concurrent registrations do not corrupt storage.

## Milestone 2: Working container launch

- Create a minimal pinned Pi image and generated Containerfile.
- Require rootless Podman and run as the invoking UID/GID.
- Mount the project at the same absolute path as on the host.
- Preserve the invocation subdirectory when inside the selected project.
- Initialize isolated, persistent per-project Pi state.
- Run `pi --continue` by default, with `--fresh` and Pi argument forwarding.
- Add `--bash` and `--exec`.
- Implement terminal detection, signal forwarding, exit status, and disposable container cleanup.
- Forward only explicitly configured provider environment variables.

Acceptance tests:

- Pi reports the expected absolute working directory.
- New project files have the invoking user's UID/GID.
- Host home, host Pi state, SSH agents, and Podman sockets are not automatically mounted.
- Unselected host environment secrets do not appear in the container.
- Two projects have separate Pi state; state survives container replacement.
- `pis` continues a conversation and `--fresh` suppresses implicit continuation.
- Explicit supported Pi session selectors replace implicit continuation.
- Bash and exec modes receive the same environment boundaries as Pi.
- Ctrl-C, EOF, piped input, stderr, and nonzero exit codes behave correctly.
- Paths and arguments containing spaces or shell metacharacters remain literal.

## Milestone 3: Project-specific images and mounts

- Add validated apt package lists and advanced build instructions.
- Generate minimal build contexts containing no host source or credentials.
- Fingerprint image inputs and reuse matching images.
- Implement automatic builds, `--build`, and `--rebuild`.
- Add extra same-path mounts with read-only defaults.
- Reject broad, duplicate, conflicting, and reserved-path mounts.
- Handle SELinux labeling without recursive host ownership changes.

Acceptance tests:

- Additional read-only directories reject writes; read-write directories allow them.
- Sharing configured for one project is absent from another.
- External symlinks do not expose unmounted host targets.
- Package changes rebuild; mount or credential changes do not.
- A failed build does not silently launch a stale image.
- Generated build context excludes source, API keys, and Pi state.
- Package values cannot inject shell commands.
- Generated final runtime settings remain correct after supported customization.
- Tests pass on an SELinux-enforcing host as well as a non-SELinux host.

## Milestone 4: Operational reliability and hardening

- Add `--doctor` for Podman availability, rootless mode, subordinate IDs, permissions, and image prerequisites.
- Exercise capability dropping, no-new-privileges, seccomp, and SELinux behavior.
- Evaluate resource limits and a read-only root filesystem with explicit writable paths.
- Define concurrent launch behavior and state locking.
- Add safe cleanup, deletion, migration, and update workflows.
- Document the remaining network, credential, kernel, and writable-mount risks.

Acceptance tests:

- No silent rootful or privileged fallback.
- Diagnostics redact secret values.
- No configuration path grants arbitrary Podman privileges.
- Cleanup never deletes project source or unrelated host data.
- Missing/moved roots require explicit correction rather than guessing.
- Builds, editors, and interrupted launches leave recoverable state.

## Milestone 5: Host-side OpenAI and Codex credential proxies

- Keep real OpenAI API keys and Codex access/refresh tokens in host-managed proxy/credential storage.
- Provide explicit host Codex login/import/logout and coordinated refresh without exposing tokens/account identity to container configuration.
- Configure Pi to use the proxy endpoint with dummy credentials.
- Restrict upstreams, routes, and sandbox access to the proxy.
- Support streaming and normal OpenAI error behavior.
- Add credential-safe error handling and request/concurrency limits (implemented); monetary/token quotas remain future work.
- Evaluate proxy-only egress and host/LAN access restrictions.

Acceptance tests:

- The real API key is absent from container environment, filesystem, image, and state.
- Only the fixed upstream receives the real authorization header.
- Arbitrary forwarding and redirect-based credential leakage are prevented.
- Logs and errors do not reveal real credentials.
- Streaming, cancellation, and upstream failures work.
- Documentation distinguishes key secrecy from prevention of unauthorized API usage.

## Deferred scope

- macOS, Windows, and Podman Machine support.
- Pi SDK integration or a custom agent UI.
- Automatic loading of repository-controlled wrapper configuration.
- Copy-in/copy-out or worktree-based project isolation.
- VM-level isolation.

## Suggested first vertical slice

Completed: registration, same-path mounts, current UID/GID, persistent Pi state, default continuation, fresh mode, Bash/exec, image customization, and real rootless Podman verification. The OpenAI API-key and Codex OAuth proxies are also implemented and tested with fake upstream/auth services. Image-baked npm extensions and configuration completion are also implemented. Next priorities are interactive feedback, SELinux verification, advanced package-source/update support, and operational hardening.
