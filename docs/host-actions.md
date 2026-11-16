# User-approved host actions

The opt-in [`--auto-wait-codex` quota service](codex-wait.md#hostcontainer-boundary) is **separate** from these approval tools. Its socket accepts only a fixed usage-wait query and returns availability states; it cannot approve/install packages, execute Git or arbitrary commands, select URLs, or supply continuation prompts. With a host-configured [Codex account pool](codex.md#optional-automatic-quota-failover), that fixed wait query may internally choose a verified available enrolled account after confirmed exhaustion; the sandbox cannot name an account, enroll profiles, alter pool policy or obtain credentials/identity. Global account management remains host CLI only. Automatic quota recovery never bypasses the host confirmations described below. An apt/Git-approved Pi restart preserves the CLI auto-wait opt-in and creates a fresh extension runtime.

[Managed Pi/npm updates](updates.md) are another separate, **host-configured opt-in** (`pis --updates on|all`). They add no sandbox host-control tool and do not authorize apt/Git proposals. A worker builds only from the stored trusted image recipe and validated npm metadata, supplies no real model/auth capability, and tests with fake services in a separate network-disabled container. Next-launch activation is host-side and never interrupts a task or sends a model-triggering continuation prompt. Exact pins move only after explicit `all`/`includePinnedExtensions` consent. The bounded private `.pi` backup is outside container mounts; image rollback never restores state automatically. `PI_SELF_UPDATE_COMMAND` is not a generic host/Podman bridge.

## Implemented first step: apt packages

Interactive `pis` runs expose an image-owned `request_apt_packages` Pi tool. It submits one small, typed JSON proposal over a private Unix socket. The socket grants permission to **suggest**, not permission to change anything. Direct, print, ordinary RPC, `--no-session` and custom-stdio launches do not expose this service. Explicit web `--allow-web-git` exposes a **Git-only** proposal socket, never apt approvals; see below.

The tool reports that nothing has been installed and requests an orderly Pi shutdown. After Podman exits, pis removes the container and checks that it no longer exists. It then closes the proposal service before prompting on the host terminal. The user must type a fresh random two-digit confirmation code; Enter or any other response declines.

Only the validated package list held in host memory is used after confirmation. No approval field, filename, shell command, configuration patch, URL, or generic command is accepted from the sandbox. Unknown action types and unknown fields are rejected. At most ten simple apt names and a bounded explanation are accepted; shell syntax, versions, terminal controls and bidirectional formatting controls are rejected.

Approval saves an additive `image.packages` change using the normal registry lock, stale-config check, validation and atomic write. Existing settings are retained. After approval, pis releases the old project lock, builds the new image and restarts Pi with `--continue`. It does not replay an initial prompt or one-off CLI arguments. On the automatic restart, after the image build succeeds, a single English user prompt lists the approved packages and asks the agent to continue its previous task. Only package names are included, not the untrusted reason. This starts a model turn and uses tokens; the confirmation dialog explains this. Normal later starts do not repeat the message. A build/start failure is reported normally; approved configuration changes remain saved for retry, but the in-memory continuation notice is not queued for a future manual launch. Decline makes no changes and does not restart Pi. If another process edited the configuration meanwhile, saving fails rather than overwriting it.

New projects start with `build-essential` and `python3` as visible, editable package defaults. Existing explicit package lists, including an empty list, are not migrated. Approved project apt additions now sit above the shared Pi/plugin runtime prefix, so changing an apt list can reuse those expensive installation layers; apt/custom instructions still precede the final bootstrap. The approval/stopped-container/restart/continuation contract is unchanged. This affects future builds, not running images, and does not reclaim old caches automatically. See [image layout and pending real-container verification](image-storage.md).

### Trust limits

The model can suggest inappropriate packages or misleading reasons. The reason is explicitly untrusted; the exact package names are what the user approves. Package installation can execute Debian maintainer scripts inside the image build. Confirmation does not mean a package has been audited.

This is not a defense against a malicious host user, kernel/container escape, or all terminal-emulator attacks. The sandbox may print misleading text while it runs. Real authorization happens in pis after the sandbox has been stopped, with a new confirmation challenge not supplied by the sandbox. The two-digit code prioritizes usability and protection against accidental generic responses, not strong resistance to guessing; it is not an authentication secret. Never approve solely because the model says an operation is safe.

## Host Git commands: push implemented

The image-owned `request_host_git` tool accepts a relative `repo`, an `args` array (without the `git` executable), and a short `reason`. It proposes a single Git command, never a shell string. Currently the only allowlisted form is:

```json
{
  "repo": ".",
  "args": ["push", "origin", "FULL_40_HEX_COMMIT:refs/heads/main"],
  "reason": "Publish the reviewed changes"
}
```

The 40-character hash above is a placeholder: the agent must obtain a real full commit hash inside the sandbox. Other subcommands, aliases, global Git options, force pushes, deletion refspecs, tags and multiple commands are rejected. New Git operations must receive their own host validation before being added to this allowlist.

After the sandbox stops, pis resolves the requested remote's single `pushurl` (or `url`) without processing includes or URL rewrites. It snapshots only regular SHA-1 loose objects and pack/index files into a new private bare repository, verifies the requested commit and runs strict object integrity checking. It never runs Git from the shared working tree or copies hooks, refs, object alternates or repository configuration. The snapshot is capped at 2 GiB and 100000 object files. Ordinary in-project absorbed submodules (including nested `.git/modules/.../modules/...` layouts) are now supported by resolving a regular <=4KiB `.git` pointer only into the registered root's canonical `.git/modules` tree. External pointers, symlinked module directories and shared `commondir` worktrees are refused. The owning registered root must have an ordinary `.git` directory; registering an absorbed submodule alone whose Git directory is outside that root is not supported. Shallow/partial repositories with missing objects, alternate-object dependencies, hardlinked objects and SHA-256 repositories remain unsupported. Push each submodule explicitly using its own relative `repo`/remote/commit/ref, then propose any parent gitlink commit separately; no recursive push is added.

The host approval dialog shows the relative repository, remote name, normalized destination URL, exact full commit and destination branch. The user enters a fresh two-digit challenge; decline deletes the temporary snapshot and performs no push. Approval executes an argument array with `/usr/bin/git`, the exact object/ref, no force, no hooks, disabled submodule recursion, no credential helpers, no HTTP redirects and no inherited Git configuration or arbitrary process environment. Git's ordinary non-fast-forward protection applies. The snapshot cannot be reused for a second push.

SSH and HTTPS URLs on standard ports are supported; local paths, `file:`, `ext:`, embedded HTTPS credentials, encoded/ambiguous URLs and custom ports are rejected. For SSH, pis uses `/usr/bin/ssh` with host configuration disabled, no proxy/local commands/forwardings, batch authentication and strict host-key checking against the host user's `~/.ssh/known_hosts`. The host SSH agent and default identity files remain available, but aliases/custom identities from `~/.ssh/config` are not used. A previously verified host key and usable host identity/agent are required. HTTPS may prompt on the host terminal for username/token; saved credential helpers and host Git configuration are intentionally not loaded. Credentials are never mounted into the sandbox.

After Git reports success, Pi restarts and receives one English user message identifying the completed push and asking it to continue. This uses model tokens. A failed push is reported without automatic retry or a success message; a later request requires fresh approval. The temporary snapshot is removed on normal completion, rejection and errors. A host crash can leave a private `/tmp/pis-push-*` directory; these snapshots contain source object data, not copied host credentials.

## Explicit web Git-push approval (opt-in on the agent host)

Default web RPC still has **no host push authority**. To delegate this narrow approval authority to authenticated admins of the selected server for one launch:

```sh
# On the host owning the registered Pi project:
pis --connect --allow-web-git
# Or an all-in-one host with explicitly selected local projects:
pis --server --project NAME --allow-web-git
```

Advanced `pis --connect run NAME --allow-web-git` also works. This choice is not saved in client profiles or inferred from enrollment; it must be supplied each launch. It is refused for dummy/standalone-only starts and server-preference changes. **Trust the server and its administrators**: an opted-in remote controller can authorize a push on this host. Ordinary registration/SSH forwarding alone does not grant this authority. No remote apt approval, arbitrary Git/shell tool, credential export or automatic push is added.

The image-owned `request_host_git` tool uses the existing typed proposal socket (apt is both hidden and refused in this mode). The sandbox must exit and the host must independently remove/check its container before preparation/approval, retaining the project lock while reviewing. The same private object snapshot, URL normalization, integrity checks and exact-commit non-force push are reused for submodules and main repositories. A separate trusted-wrapper IPC channel supplies the prepared descriptor; Pi stdout, extension dialogs and model text cannot become approvals. While host review is pending the native control adapter faults closed, so old prompt/stop writes cannot be mistaken for a new Pi runtime.

Select the agent and open **Godkänn Git-push** in the sidebar/mobile menu. The card shows relative repository (including submodule), remote, normalized destination, full commit and branch; the reason is explicitly untrusted. Click **Granska push**, then enter the fresh two-digit code shown by the host-owned proposal and click **Godkänn push**, or **Avböj**. The code prevents accidental generic confirmation; it is not authentication. Origin-checked authenticated browser WebSockets carry a one-use review nonce bound to that browser/session, selected agent, runtime generation and exact proposal. Logout/disconnect/selection changes invalidate the review nonce. A different session must manually request a fresh review; replayed decisions and changed generations cannot authorize another push. Host approval expires after five minutes and is independently checked on the host; clocks should be reasonably aligned for cross-host expiry validation.

No approval is queued or replayed after connector/server transport loss. A pending host proposal is declined on connector disconnect; an already approved push may finish, so lost results are **unknown**, not proof of failure. Server state is bounded/ephemeral and is never written to registration files. Revocation cannot undo an already authorized remote Git operation. Browser **Stoppa** controls Pi, not host approval: use the explicit decline action or stop the local connector.

Web pushes are **noninteractive**, with stdin/stdout/stderr suppressed, credential helpers disabled and a two-minute Git deadline plus owned-process-group termination. No raw Git/SSH stderr reaches chat/diagnostics. SSH uses only the existing strict host-key/batch-auth policy and host-owned identity/agent; no password or host-key prompts. HTTPS credential prompts are disabled, so remotes requiring interactive username/token login must be handled manually (normally configure a supported SSH remote on the host). Keys are never mounted into the sandbox or sent to the server. Reported success requires Git exit zero. Failures, timeouts or lost final results are unknown and must be checked on the host/remote before a new independently approved proposal; snapshots cannot be retried.

Unlike the terminal flow, this first web version **does not restart Pi or generate a model continuation prompt**, even after success/decline/expiry. Reconnect/start the project manually when safe to resume its saved session with a new generation. There is no automatic recursive submodule/parent push. This avoids bridging a new Pi process onto an old RPC/control generation or spending model tokens as an implicit approval side effect.

Verification: local IPC one-use/timeout/cancel tests, real HTTP/WebSocket admin-session/logout/generation tests, literal browser-card tests, real local Git/submodule snapshots and fake-Podman stopped-container/retained-lock/decline tests. Actual Podman + SSH/submodule deployment and complete graphical-browser approval remain host verification gates. No external Git push or live model request was made.

This design prevents shared Git hooks/configuration from becoming an arbitrary host-command interface. It still trusts the host Git/SSH binaries and their object/protocol parsers; keep them patched. The size cap is not a comprehensive CPU/memory sandbox for malicious Git objects.
