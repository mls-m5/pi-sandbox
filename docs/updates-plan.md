# Pi/plugin updates: current upgrade and proposed automatic maintenance

## Implemented now

The image pins **Pi 1.5.0**, the npm `latest` release checked during this work (published 2026-11-02), instead of 1.2.0. It remains an exact pin, not `@latest`. Changing the generated image contents changes its fingerprint; the next host `pis` launch builds/selects the new image. Already running containers are not modified. Existing project extension arrays and their explicit versions remain unchanged, including `pi-web-access@0.40.0`.

The image-owned approval extension now imports `Type` from `typebox`, the documented Pi 1.5 API. The Codex fake-service integration fixture uses `gpt-6-luna`: upstream removed older models, including `gpt-5.3-codex-spark`, from its Codex catalogue. **No user model, allowlist, credentials or session is migrated automatically.** If a saved model is no longer offered, choose a supported model using `/model` and explicitly adjust any allowlist. The upstream default model also changed; an application upgrade is not a promise of an unchanged model catalogue.

### Verified versus pending

- `npm run check`: syntax and offline/fake-service tests; does not download Pi or make model requests.
- New opt-in real-Pi compatibility probe: runs the exact installed candidate CLI against a local fake Codex server through the actual credential proxy and a local Unix-socket relay. Checks SSE, synthetic auth, approval-tool registration, TypeBox bounds (an empty apt array never executes), a harmless rejected proposal and the `agent_settled` lifecycle event.
- The same probe can explicitly load the already-installed image `pi-web-access` and verify tool registration. It does not perform a live search or use account credentials.
- The probe ran successfully with actual Pi 1.5.0 and image Web Access 0.40.0 inside the sandbox. Child HOME/auth are fresh and fake. A network guard restricts the child's fetch/socket destinations to the local fake services; **this guard is not an OS security sandbox for arbitrary candidate code**. Run untrusted candidates in an isolated test container/CI job without host credentials or a real model proxy capability.
- Full real-Podman integration, graphical/TUI interaction, real subscription login and the watchdog/private-child interaction remain separate verification steps. No paid/live model requests were made.

Run the probe with an **already installed** candidate (no package installation occurs in this command):

```sh
PIS_PI_PACKAGE=/path/to/node_modules/@earendil-works/pi-coding-agent \
  npm run test:pi-compat

# Inside the generated pis image, additionally check the default web extension:
PIS_PI_PACKAGE=/usr/local/lib/node_modules/@earendil-works/pi-coding-agent \
PIS_PI_WEB_ACCESS=/opt/pis/agent/npm/node_modules/pi-web-access \
  npm run test:pi-compat
```

`test:pi-compat` fails if its target is omitted; ordinary `npm run check` skips this opt-in suite when `PIS_PI_PACKAGE` is absent. The other skipped suites need real Podman.

## pi-continue-watchdog

The current upstream watchdog requires Pi >=1.3.0, so the image's Pi-version requirement is now satisfied. **The watchdog has not been installed into a user's project, enabled by default, or verified end-to-end here.** It is a Git package, not an npm package accepted by the current image `extensions` schema.

After rebuilding/restarting on the host, its manual installation form is:

```sh
pis -- install git:github.com/xz-dev/pi-continue-watchdog
```

This is installation into writable per-project Pi state, not an image configuration entry. Do not run it concurrently with that project's active pis session. Review the source before installing: a manual Git install may execute dependency install scripts **inside the sandbox**. The wrapper's image build instead disables npm lifecycle scripts; globally enabling scripts to make every package work is not an acceptable update design.

Upstream's current package declares commit-pinned `pi-extension-utils` and a private subagent runtime. The utils dependency has a `postinstall` preparation step that patches the package-local private runtime. Git image support must account for that explicitly; merely cloning the top-level source or suppressing all scripts is not a verified working installation. Any managed build should pin the source/dependency commits and review/allowlist the specific preparation step in a credential-free build container. Never execute it on the host.

The watchdog makes private model decisions and can continue apparently completed work. These use model quota. Its terminal-error unlock, per-cycle continuation budget and recognition of extension-injected user messages must be tested with our `--auto-wait-codex` continuation; do not assume the two independent continuation controllers share one budget or are proven compatible. Git `master` can change while its `package.json` version remains unchanged, so updates must track commit IDs, not just a version string.

## Proposed automatic maintenance — NOT implemented or enabled

The goal is no per-update user work after opting into a trusted managed channel. **Do not implement this by installing `latest` on every launch or letting a running Pi update its own root-owned installation.** Pi/plugin updates are executable-code changes, not just a freshness check.

### Policy and resolution

- Add one explicit policy choice, e.g. `managed-stable` versus `manual`, with an off switch and rollback command. These are proposed names, not accepted config fields/commands today.
- Follow a tested release channel, with a release-age window and exact resolved versions/commits/integrities. New major versions or incompatible migrations wait for maintainer review, not blind promotion. Semver/peer ranges alone are not a compatibility or security proof.
- Keep a private, atomic host release manifest recording active, candidate and previous-known-good Pi/plugin artifacts and verification results. Source URLs must be bounded validated public package/Git metadata endpoints, never shell strings, credentialed URLs or sandbox-selected arbitrary host paths.
- Distinguish **managed moving sources** from deliberate exact pins/tags. Preserve explicit project choices: `extensions: []` stays empty, removed plugins stay removed, and pinned user versions do not silently become `latest`. Opting a pin into automatic movement needs an explicit policy decision once, not a silent rewrite of the JSON.
- Include transitive lockfiles/integrities and approved script hashes where possible. Today's exact top-level versions do not fully lock npm transitive dependencies or apt repositories.

### Check, build, test, promote

1. Check metadata at most daily, in a host worker separate from interactive startup. No model requests, host package scripts, extension imports or arbitrary host Git execution. Failed/offline metadata checks leave the known-good image usable.
2. Resolve an exact candidate set. Build in a fresh rootless container with no project source, host auth, model proxy capability, SSH agent or engine socket mounted. Review/allowlist required preparation steps; do not enable all npm scripts indiscriminately.
3. Build in a separate immutable candidate context, not the live `build/` directory or writable Pi state. Use a separate update-build lock and explicit image leases. A normal launch must be able to keep using the known-good image instead of waiting for maintenance or replacing a running version.
4. Gate promotion on fast tests, the real-Pi compatibility probe, real-Podman fake-upstream tests, extension loading, and fake-backend PTY tests for approval/cancellation/quota continuation. Include the actual configured extension set, particularly watchdog private children, not only an empty Pi install. Test jobs have no live credentials or publishing tokens. Do not spend model quota as an automatic smoke test.
5. If a release removes the user's selected model or requires an incompatible state migration, keep the old image and report the required decision instead of silently renaming models or changing providers. Routine compatible updates should need no user action; genuinely breaking/account-specific changes can still require one.
6. Promote atomically at a safe launch boundary under the project lock. Never stop/restart a running task to update it; a long quota-waiting session keeps its original image/runtime. Never replay a task because an update completed. Show one concise version/change notice, not a model-triggering user message.
7. Keep known-good artifacts and the last failure report. Retry failed checks/builds with backoff, not on every launch. Integrate active/candidate/previous-good leases with `--prune` before enabling automatic maintenance: current retention logic does not know these new roles.

### State and rollback

Rolling back an image **does not undo** session-format or plugin-state mutations. Before activating a candidate, define private state backups/migration checks and an explicit, bounded retention policy. Keep backups out of the container and never log their contents; existing sandbox state can contain sensitive data. Do not broaden cleanup to delete source, credentials or state silently. Reject promotion if compatibility/rollback requirements cannot be met.

Manually installed plugins currently live in mutable project state. Running `pi update --extensions` while another agent uses that directory is not a safe background updater. Prefer migrating opted-in managed plugins to immutable, versioned image artifacts once Git builds/preparation are supported; otherwise maintenance needs an isolated staging copy, no active session, and an atomic switch with rollback. Never install/execute a manually configured package on the host or copy all Pi settings into the host update worker.

Pi 1.5 also refreshes unpinned temporary `-e npm:...` / branch-based `-e git:...` packages at startup/reload, retaining cached copies on failed checks. Our image bootstrap loads local immutable package roots instead, and ordinary manual installed packages have different update semantics. Per-launch untested moving dependencies are not a replacement for a jointly tested Pi/plugin release set.

Pi 1.5 provides `PI_SELF_UPDATE_COMMAND` / `selfUpdateCommand`, but that command runs **where Pi runs — inside our container**. It is not permission to call a generic host command or expose Podman. The existing apt/Git proposal approval contracts remain unchanged. A future wrapper-managed update action needs its own narrow design, not a shell bridge through those tools.

## Related follow-up: stale locks

Implemented host commands: `pis --unlock --dry-run` and `pis --unlock`, optionally with `--project`. Recovery distinguishes global registry and project locks, validates private bounded metadata/owner/file identity, refuses live/unverifiable owners, and checks remaining containers before releasing project locks. A kernel `flock` serializes recovery and releases automatically after crashes; the original inode remains open while rechecking. New locks record boot/start stamps, while legacy PID-only locks remain supported conservatively. No force option, container deletion or sandbox host-control bypass. Ten offline/local CLI tests pass. Automatic update workers must not introduce unconditional stale-lock stealing or hold the global registry lock during downloads/builds.

References: [Pi npm release metadata](https://registry.npmjs.org/@earendil-works/pi-coding-agent/latest), [Pi package/update docs](https://pi.dev/docs/latest/packages), [watchdog source and requirements](https://github.com/xz-dev/pi-continue-watchdog), [existing image package behavior](extensions-plan.md).
