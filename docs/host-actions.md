# User-approved host actions

## Implemented first step: apt packages

Interactive `pis` runs expose an image-owned `request_apt_packages` Pi tool. It submits one small, typed JSON proposal over a private Unix socket. The socket grants permission to **suggest**, not permission to change anything. Direct, print, RPC, `--no-session` and custom-stdio launches do not expose this service.

The tool reports that nothing has been installed and requests an orderly Pi shutdown. After Podman exits, pis removes the container and checks that it no longer exists. It then closes the proposal service before prompting on the host terminal. The user must type a fresh random two-digit confirmation code; Enter or any other response declines.

Only the validated package list held in host memory is used after confirmation. No approval field, filename, shell command, configuration patch, URL, or generic command is accepted from the sandbox. Unknown action types and unknown fields are rejected. At most ten simple apt names and a bounded explanation are accepted; shell syntax, versions, terminal controls and bidirectional formatting controls are rejected.

Approval saves an additive `image.packages` change using the normal registry lock, stale-config check, validation and atomic write. Existing settings are retained. After approval, pis releases the old project lock, builds the new image and restarts Pi with `--continue`. It does not replay an initial prompt or one-off CLI arguments. On the automatic restart, after the image build succeeds, a single English user prompt lists the approved packages and asks the agent to continue its previous task. Only package names are included, not the untrusted reason. This starts a model turn and uses tokens; the confirmation dialog explains this. Normal later starts do not repeat the message. A build/start failure is reported normally; approved configuration changes remain saved for retry, but the in-memory continuation notice is not queued for a future manual launch. Decline makes no changes and does not restart Pi. If another process edited the configuration meanwhile, saving fails rather than overwriting it.

New projects start with `build-essential` and `python3` as visible, editable package defaults. Existing explicit package lists, including an empty list, are not migrated.

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

After the sandbox stops, pis resolves the requested remote's single `pushurl` (or `url`) without processing includes or URL rewrites. It snapshots only regular SHA-1 loose objects and pack/index files into a new private bare repository, verifies the requested commit and runs strict object integrity checking. It never runs Git from the shared working tree or copies hooks, refs, object alternates or repository configuration. The snapshot is capped at 2 GiB and 100000 object files. Worktrees/submodules with `.git` files, shallow/partial repositories with missing objects and SHA-256 repositories are not supported in this first version.

The host approval dialog shows the relative repository, remote name, normalized destination URL, exact full commit and destination branch. The user enters a fresh two-digit challenge; decline deletes the temporary snapshot and performs no push. Approval executes an argument array with `/usr/bin/git`, the exact object/ref, no force, no hooks, disabled submodule recursion, no credential helpers, no HTTP redirects and no inherited Git configuration or arbitrary process environment. Git's ordinary non-fast-forward protection applies. The snapshot cannot be reused for a second push.

SSH and HTTPS URLs on standard ports are supported; local paths, `file:`, `ext:`, embedded HTTPS credentials, encoded/ambiguous URLs and custom ports are rejected. For SSH, pis uses `/usr/bin/ssh` with host configuration disabled, no proxy/local commands/forwardings, batch authentication and strict host-key checking against the host user's `~/.ssh/known_hosts`. The host SSH agent and default identity files remain available, but aliases/custom identities from `~/.ssh/config` are not used. A previously verified host key and usable host identity/agent are required. HTTPS may prompt on the host terminal for username/token; saved credential helpers and host Git configuration are intentionally not loaded. Credentials are never mounted into the sandbox.

After Git reports success, Pi restarts and receives one English user message identifying the completed push and asking it to continue. This uses model tokens. A failed push is reported without automatic retry or a success message; a later request requires fresh approval. The temporary snapshot is removed on normal completion, rejection and errors. A host crash can leave a private `/tmp/pis-push-*` directory; these snapshots contain source object data, not copied host credentials.

This design prevents shared Git hooks/configuration from becoming an arbitrary host-command interface. It still trusts the host Git/SSH binaries and their object/protocol parsers; keep them patched. The size cap is not a comprehensive CPU/memory sandbox for malicious Git objects.
