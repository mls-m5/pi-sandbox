# Next task: reduce image storage and share runtime layers

## User request

The host filesystem filled up while running/building multiple pis projects. The user wants the containerized development agent to optimize image construction so agents share a common runtime and add project-specific tools above it. This document records the host diagnosis and original proposal. **The cache-friendly layout and same-step npm-cache cleanup are now implemented for future builds**; see [image-storage.md](image-storage.md) for the exact order/compatibility contract, tests and separate opt-in host benchmark. No real-Podman comparison was possible in the sandbox, so physical savings remain unmeasured. The existing private prune-worker mutex is now included in conservative `--unlock` recovery; no host lock was removed.

Read `src/container.js`, `src/updates.js`, `src/prune.js`, [managed updates](updates.md), [the update plan](updates-plan.md) and [the handover](handover.md) before changing image identity/build behavior. Pi/Claude support and managed updates were added after the original simple image builder.

## Confirmed host diagnosis

Reported failure:

```text
Error: creating container storage: creating an ID-mapped copy of layer
"4daec0a471823177af399b3602e1696b5f0bad9b993a6ab5ee7fe91b252904dc":
error during chown: storage-chown-by-maps:
lchown root/.npm/_cacache/content-v2/sha512/68/82:
no space left on device: exit status 1
```

This was actual filesystem exhaustion, not an authentication/session error or inode exhaustion:

- `/`, HOME, `/tmp` and Podman graph storage are on the **same ext4 partition**, `/dev/nvme0n1p6`.
- `df -h /` initially showed 336G total, 319G used, only 134–135M available to the normal user (100%). The difference between total/used and user-available space is consistent with ext4 reserved blocks; reserved-block settings were not inspected or changed.
- Inodes were only 34% used.
- Rootless Podman uses overlay storage at `~/.local/share/containers/storage`; startup was creating an ID-mapped layer copy, requiring additional space even though the image already existed.
- The `.npm/_cacache` path in the error is **inside an image layer**, not evidence that the project's session data is damaged.
- The current checkout is registered as project `pbktv`, root `/home/mattias/Prog/Experiment/pi-sandbox2`. Its persistent `state` was 112M and session files were still present. Do not recreate the project or remove its state to address this error.

### Measurements before and after the user's prune

Point-in-time observations, not permanent size promises:

| Measurement | Before prune | After prune |
| --- | --- | --- |
| Filesystem available space | ~134M | ~7.8G |
| Podman image/layer space (`podman system df`) | 44.18GB | 36.98GB |
| Allocated graph storage (`du`) | ~44G | ~37G |
| Image inventory records, including intermediate layers | 494 | 376 |
| Untagged image records | not separately counted | 325 |
| Persistent pis data (`~/.local/share/pis`) | ~8G | ~8G |

Two running containers' writable layers totaled about 2MB. Container writable layers were **not** the major disk consumer. An unused volume was ~4MB; eight external Buildah workspaces also existed. Their full unique disk contribution was not isolated.

After prune, among named pis images there were **32 distinct image IDs**, 360 layer references but only **176 distinct referenced layers**. Five layers were referenced by all 32 images: Podman already shares identical layers. Named pis images ranged approximately 0.56–1.68GB in virtual size. Do not sum those virtual sizes as physical storage consumption.

A `du -s -B1` scan over readable overlay `*/diff/...` directories found approximately:

| Layer directory category | Paths found | Allocated data |
| --- | --- | --- |
| `root/.npm` | 55 | 3.57 GiB |
| `usr/local/lib/node_modules/@earendil-works` | 28 | 4.28 GiB |
| `opt/pis` (image plugins/runtime) | 128 | 4.88 GiB |

These are diagnostic directory totals, **not guaranteed reclaimable bytes**. They include different versions/intermediate/possibly ID-mapped copies; the Pi path does not cover every hoisted dependency. Not everything is redundant or safe to delete. Multiple-GB savings are plausible, but no optimized comparison build has been measured.

## Pre-optimization construction and likely duplication (historical)

Before the implementation, `containerfile()` did roughly:

1. Pinned Node base.
2. One apt installation combining common tools and **project-specific** packages.
3. Pi installation (or managed verified install).
4. Optional Claude installation and image npm extension installation.
5. Custom instructions, runtime/helper copies and permissions.

Changing a project's apt list invalidates later installation cache steps. Projects with different tools can therefore repeat Pi/plugin installations instead of sharing those runtime layers. Repeated source/bootstrap revisions and retained old builds add more layers. npm caches left by installs also persist in images.

Distinct project tags alone do **not** imply duplicated physical layers. Podman already reuses identical cached base layers. ID-mapped copies may still add storage depending on namespace mappings and engine behavior; a shared base does not eliminate every such copy.

## Original proposed implementation direction

1. Separate stable common dependencies/runtime installation from project customization.
2. Put common apt tools (and deliberate default packages), Node/Pi and reusable runtime dependencies **before** project-specific apt packages.
3. Share extension layers for identical source/version sets. Preserve explicit project extension arrays, including `[]` and differing pinned versions.
4. Place project-specific apt additions and custom instructions above the shared runtime; keep frequently changing small bootstrap files late where practical.
5. Remove npm download/cache data **in the same RUN/install step that creates it**. Deleting it in a later layer only adds whiteouts and does not shrink the lower layer. Check Pi extension installer and managed tarball installer caches too.
6. Do not assume a new global mutable base tag is necessary: a cache-friendly common Dockerfile prefix can already share layers. If explicit base artifacts/tags are introduced, fingerprint their complete inputs and account for retention, concurrent builds and lifecycle ownership.
7. Evaluate copied-up files caused by recursive permissions changes; avoid needlessly rewriting large immutable package trees when safe build-time ownership/modes can be established earlier.
8. Benchmark clean/cached builds and multiple differing projects, then report actual shared/unique/allocated bytes and startup behavior. Do not promise an exact saving before measuring.

### Compatibility and security requirements

- Preserve managed artifact verification, immutable staged release IDs, production probes, active/candidate/previous leases, activation authorization and rollback. A common base must not make an old release silently point at changed content.
- Preserve Pi/Claude separation, package customization, current user identity, read-only runtime files, proxy capabilities and host-action tool availability.
- Reordering must not silently remove user packages or ignore existing custom instructions. Identify any project relying on the old install ordering and document/test the intended new contract.
- Build contexts must still exclude source, host state and credentials. No scripts/package code should start executing on the host as part of this optimization.
- Do not expose host Podman sockets/SSH/home to a containerized development agent to perform benchmarks. Fast tests can run in the sandbox; host engine testing needs the user's host terminal or an existing explicitly authorized test environment.
- Keep running containers untouched. New layout applies to future builds. Old image/cache layers do not disappear merely because future builds improve.
- Do not broaden normal automatic pruning to delete arbitrary layers, Buildah workspaces, volumes, session histories, update backups or unrelated images. Any new base-image retention must integrate with existing safeguards.

## Recovery/cleanup findings to handle separately

At investigation time `pis --prune --dry-run` was blocked by `~/.local/share/pis/prune.lock`. `inspectLock()` verified its owner PID 3365248 was **stale/dead**. Current `--unlock --dry-run` inspected registry/project locks but did not include this prune lock. No lock was removed during this diagnosis.

Consider adding the prune worker lock to the existing conservative, kernel-flock-protected recovery flow. Do not suggest blindly deleting lockfiles or stealing a live owner's lock. Confirm the state again on the host; this is a historical observation, not current authorization to delete that exact file.

The user ran ordinary `podman image prune` and recovered ~7–8GB. That does not remove every old named image or all intermediate layers. Keep safety distinctions between:

- `pis --prune`: conservative registered-project image tags with leases/retention/locks.
- `podman image prune`: eligible dangling image/cache records, still engine-controlled.
- Buildah workspaces: may belong to live builds even when absent from ordinary `podman ps`.

Do not run `podman system reset`, remove the Podman graph directory, or delete pis state as a space-recovery shortcut. Leave adequate free space for copy-on-write builds and ID mapping (several GB; ~5–10GB headroom was recommended, not a guaranteed requirement).

## Verification checklist

- Unit tests for new build layout/identity, extension and agent variants, literal package quoting and update leases.
- Different project package lists reuse the intended runtime layers; identical configs still reuse identical images.
- No npm caches remain in the newly created installation layers, not just hidden by later deletions.
- Real rootless Podman build/start after package approval; normal continuation and host tools remain intact.
- Managed candidate build/probe/activate/rollback still works without mutable shared artifacts.
- Pruning cannot remove bases/releases needed by running containers or retained update versions.
- Report measured before/after disk use, and distinguish physical layer bytes from virtual image sizes.
- `npm run check`; use existing fake-upstream tests, not paid model calls or external pushes as smoke tests.

No image-build/storage code was changed while preparing the original diagnosis. The subsequent implementation is documented in [image-storage.md](image-storage.md): shared prefix without mutable global bases, late project apt/customization/probe code, same-step cache cleanup, unchanged managed verification/leases and explicitly scoped prune-lock recovery. Tests are offline; real-engine before/after numbers and full integration gates remain pending.
