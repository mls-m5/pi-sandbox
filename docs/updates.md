# Managed Pi/npm image updates (opt-in)

A first implementation is available. It builds/tests an exact release separately and activates it on a later launch, never by updating or restarting a running agent. It is **off by default**. This is narrower than the full [maintenance design](updates-plan.md).

## Enable once, on the host

```sh
pis --updates all       # Pi patches + compatible updates of image npm plugins, including exact pins
# Or preserve exact plugin pins:
pis --updates on

pis --updates status
pis --updates check     # Optional: prepare now in the foreground; may download/build an image
pis --updates off       # Stop checks/activation; freeze the already active managed release
pis --updates rollback  # Switch to the retained previous image and disable updates
```

All commands accept `--project ID_OR_NAME`. `on`, `all` and `off` can change policy while Pi is running; the running process/image is untouched. Rollback requires the project to be idle. `all` is explicit one-time consent to move exact npm pins within the supported compatibility line. `on` preserves the existing `includePinnedExtensions` choice: it does not revoke a previous `all`. To revoke that choice, set the field below to `false` explicitly. No command rewrites the declared extension sources or re-adds removed plugins.

Equivalent project configuration:

```json
"updates": {
  "enabled": true,
  "includePinnedExtensions": true
}
```

Missing policy fields complete to `false`. `extensions: []` stays empty. Existing projects remain manual until opted in. This manages stored Pi-project configurations, not Claude Code or Pi mode overrides of a Claude project.

`PIS_AUTO_UPDATE=0` suppresses background scheduling **and automatic candidate activation** for that invocation, without changing policy or abandoning an active release. Explicit `--updates check` can still prepare a candidate when project policy is enabled. `--rebuild` retains its declared-source rebuild behavior: that invocation uses the source-pinned baseline rather than the managed image. It does not reset the managed release pointer; later normal launches use the active managed release again. `--build` likewise ensures the declared baseline. `--show` reports the effective active image/version and any queued candidate without starting Podman.

## What happens automatically

- Launches that reach image readiness, and their exits, schedule detached host maintenance. Enabling `on`/`all` also schedules it. Checks are throttled to once per day per configuration/policy, including failures; no persistent daemon or system timer is installed. If there is no launch/enable/exit event, a dormant project is not checked. A short session may finish before its candidate is ready; activation then waits for another launch.
- Pi follows **patches of the wrapper's pinned minor line** (currently 1.5.x). Opted-in stable plugin pins follow the same major when >=1, or the same minor when 0.x. Stable unversioned/dist-tag sources are resolved to exact versions; an established moving release is not automatically downgraded while policy is unchanged. Explicitly revoking pin movement can select the original declared pins again. A first unversioned/tag resolution has no recorded installed version to anchor, so it starts from that tag's stable line. Moving releases must be at least **48 hours old**; prerelease-only sources remain manual. This is a conservative channel rule, not a security or compatibility proof.
- Metadata comes only from the fixed public npm registry over HTTPS, with no redirects and bounded response/time/package counts (up to 99 image plugins). Credentialed/custom registry URLs, Git sources and arbitrary host commands are not accepted. Remote tarball URLs and arbitrary metadata fields are never copied into host release state.
- Builds use a unique private `update-build-*` context containing only generated recipes/helper code and exact public package locks. No project source, writable agent state, host auth, SSH agent or engine socket is mounted. Existing trusted custom image instructions still run **inside the build**; builds need apt/npm networking and are not an outbound/LAN firewall. Host proxy environment variables are not injected into the build.
- The build packs each exact top-level release with scripts disabled, verifies the tarball's SHA-512 against the resolved lock, seals it under a unique filename, then installs it with `--ignore-scripts`. Scoped/unscoped npm filename collisions cannot replace an already verified tarball. Managed builds include a unique release ID so even rebuilding an identical top-level version set cannot overwrite a retained image tag. Transitive npm dependencies, apt repositories and moving dependencies in custom `RUN` recipes are **not fully locked**; builds are not bit-for-bit reproducible.
- A separate read-only, capability-dropped, resource-bounded container runs the candidate with **no network**, writable temporary storage and no project/state/auth mounts. It checks the actual Pi version and configured image package versions/loading, local fake Codex SSE through the real proxy code and a Unix relay, tool registration, apt schema bounds/rejected proposal, `codex-auto` command registration and `agent_settled`. Configured built-in OpenAI/Codex/Mistral allowlist IDs must still exist in the native catalogue. Test auth is fresh/fake. No real account capability or paid model request is used.
- Only a passed candidate gets a private release receipt. The worker does not retag an active image or mutate a live `build/` context. Changed configuration/policy prevents publishing the candidate. Downloads/builds/probes do not hold the registry or normal project/session lock.
- At a later launch, the normal project lock and a nonblocking update lock protect activation. Busy maintenance never makes startup wait for its build. The launcher rechecks the candidate's image identity, preserves Pi rollback data (below), retags the checked image, and atomically commits the release pointer only if current policy/configuration still authorize it. It emits one host-side version notice, **not a user/model message**, and does not replay tasks.

The private `projects/<id>/updates.json` records active/previous/candidate releases, exact top-level hashes, image identities, the latest metadata-check time and a bounded failure phase. Subprocess logs, tokens, URLs and full environments are not persisted in that report. `status` also distinguishes absent/live/stale/unsafe maintenance locks. There is intentionally no unrestricted sandbox update/host-command tool; `PI_SELF_UPDATE_COMMAND` is not a Podman bridge.

## State backup and rollback

Immediately before activation, while the project is idle/locked, the launcher snapshots persisted `state/.pi` into private `projects/<id>/update-backup/pi`. It keeps **one completed snapshot**, replacing it only after a new copy completes. Limits: 256 MiB of file/link data, 20,000 entries, 1 MiB of inert link metadata and a 15-second elapsed-time check between I/O operations. Unsafe ownership, hardlinks, special files, concurrent file changes or exceeded limits defer activation and keep the current image/candidate. These are conservative limits, not a guarantee that stalled filesystem I/O finishes within 15 seconds.

The backup is outside all container mounts and may contain sensitive auth, preferences and transcripts: **do not print/share it or mount it into candidates**. Symlinks are recorded as inert text in `symlinks.json`, never followed or recreated. A symlinked `.pi` root is refused. SDK/tooling elsewhere in HOME, symlink targets and project worktree data are **not** backed up. This is not a full-machine backup or proof against arbitrary plugin migrations.

`rollback` requires the previous image to still exist with the recorded identity; it does not download an unverified replacement. It disables automatic updates and swaps image pointers. **It does not restore state or undo project changes.** The pre-activation snapshot remains available for deliberate manual recovery; stop the project, retain current data separately, and review what needs restoration rather than overwriting new work automatically. An initial never-used baseline might not have a built image available to roll back to.

Missing/corrupt managed artifacts or receipts do not trigger in-place repair of a running agent: ordinary launch falls back to the declared source baseline, building it if necessary. Changes to the wrapper's managed build/probe recipe, declared image/extension configuration or model policy invalidate old receipts; a fresh candidate must be checked. This fallback can use older declared versions than the formerly managed release. An intentional configuration change is not silently overwritten to retain a managed version.

## Cleanup, failures and scope

Normal pruning protects active, candidate and previous image tags in addition to existing configured/recent/used/shared-image safeguards; invalid update leases cause that project to be skipped. Update staging tags have a separate namespace and are not swept by normal fingerprint-image pruning. Normal success removes its staging tag/context; rollback removes a still-identical pending staging tag. No forced image/parent/cache/state pruning is added. The single completed Pi backup is only replaced by a later successful backup, never by `--prune`.

A killed worker can leave a private context, partial backup, staging tag or orphan probe. `pis --unlock [--dry-run]` now also inspects an existing `updates.lock`: it never steals live/unknown locks, and recovery refuses any remaining project container, including a probe. Recovery does **not** stop containers or clear Buildah workspaces; these need explicit host inspection. Unknown/orphan staging/context/backup data is not automatically deleted. Normal launches remain usable with the existing image while update maintenance is busy or blocked.

Not included: Git/watchdog and manually installed state plugins, lifecycle-script allowlisting, full dependency locks/signatures, exhaustive plugin/model behavior, arbitrary restored-session/custom model validation, interactive PTY approval/quota-controller tests for each release, or automatic state restoration/migration certification. The probe checks eager registration and a narrow local tool flow, not live web search or every extension function. Native catalogue checks cover explicit built-in allowlists, not every model historically selected in sessions. Semver plus these tests cannot prove a third-party release safe. Only opt into publishers/recipes you trust.

## Verification

- `npm run check`: offline/fake metadata/Podman tests; no npm downloads or live model requests. Covers policy/pin preservation, resolution/aging, integrity and tarball collision handling, separate staging, next-launch activation, revocation races, failures/fallback, backup limits, rollback, image leases, scheduling and stale maintenance locks.
- `test:pi-compat` also runs the production candidate probe against an **already installed source-pinned** Pi package, using only fake local services:

  ```sh
  PIS_PI_PACKAGE=/usr/local/lib/node_modules/@earendil-works/pi-coding-agent \
  PIS_PI_WEB_ACCESS=/opt/pis/agent/npm/node_modules/pi-web-access \
    npm run test:pi-compat
  ```

  Passed here with real Pi 1.5.0 and Web Access 0.40.0. This direct test's JS network guard is not an OS isolation boundary; automatic evaluation uses a separate `--network=none` container.
- `npm run test:integration` includes an opt-in real-rootless-Podman candidate build/probe/activation test. It downloads public npm packages but uses fake model services. **Not run here: Podman is unavailable in this sandbox.** The full build path, resource flags and read-only behavior therefore still need host verification. No live subscription/model or Git-push smoke test was made.
