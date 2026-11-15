# Shared program image with separate agent containers

Status: **requested direction, not implemented**. The user asked to record this and defer implementation until their model tokens refill. Do not start implementation, builds, package installation or automatic continuation on the strength of this note; wait for the user to resume.

## Agreed direction

Use one common, versioned Podman image for the installed program environment, while retaining a **separate running container per agent/project**:

```text
Shared pis program image
  ├─ Agent A: separate container, project mounts and persistent agent state
  ├─ Agent B: separate container, project mounts and persistent agent state
  └─ Agent C: separate container, project mounts and persistent agent state
```

Manage the common apt package list through an explicit host-side edit workflow. `pis --edit-base` was suggested as a possible command name, **not an existing command or finalized interface**. Prefer deliberately configured common dependencies over accumulating different program images per project. Do not combine all agents into one running container, install packages directly on the host, or switch to Bubblewrap as part of this work.

## Preserve the existing boundaries

- Project files, writable container layers, agent state, provider proxy capabilities and lifecycle/project locks remain separate. No extra mounts of host home, credentials, SSH agents or Podman sockets.
- Updating the common package configuration builds a new immutable image version. Existing running containers keep their image; only subsequent starts use a verified new version. Never mutate a live shared program filesystem or automatically restart agents.
- No shared provider auth/state between projects. Experimental Claude's separate real-token state remains a distinct credential boundary; whether Pi/Claude need different common runtime images must be decided explicitly.
- Existing explicit per-project package lists, custom RUN instructions, extension choices and credential settings must not be silently overwritten. Decide and document migration/override semantics before changing defaults. Do not erase project requirements to force one image.
- Host approval remains required for sandbox-proposed apt changes. Adding packages to a globally used base affects more projects than today's project-local approvals; review/edit the approval scope explicitly before enabling such proposals. Editing global packages must not grant arbitrary host-command execution.

## Storage motivation and limits

Host evidence from the reported build failure: the root/HOME/Podman filesystem was 100% full, with about 859 MiB available; inode use was 34%. Podman reported 424 images, 11 active images and approximately 39 GB image usage. These numbers are a diagnostic snapshot, not a measurement of reclaimable bytes or all disk usage. The failed build hit a closed pipe while saving an apt layer; lack of free space is the leading explanation, not proof of overlay corruption.

Podman already shares immutable image layers between containers. The goal is to reduce divergent package recipes and retained old builds, **not** to eliminate per-agent isolation or promise that all disk usage disappears. The current [image-storage optimization](image-storage.md) already reorders common runtime layers; review it before duplicating that work. Old versions, build cache and writable layers still consume space even with a common image.

## Questions for implementation after the user resumes

1. Define host-global configuration location, validation/editor schema, and explicit migration/opt-in semantics.
2. Decide common runtime/package ownership and how existing project exceptions are represented. A single common apt list does not automatically make differing extensions/custom instructions share the entire final image.
3. Specify version/fingerprint selection, build failure behavior, compatibility with managed updates/rollback, and next-start activation without interrupting running work.
4. Keep build/free-space checks and conservative cleanup policies. Never use `podman system reset`, delete graph storage/state, or sweep unrelated images/volumes to make the new layout appear effective.
5. Test shared image identity/layers with separate mounts/state/locks and preservation of explicit settings. Measure **physical allocated storage** on a host with sufficient free space; fake-engine tests and virtual image sizes cannot establish real savings.

No new command, migration, image build, host cleanup or verification result is claimed by this plan.
