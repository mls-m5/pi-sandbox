# User-approved host actions

## Implemented first step: apt packages

Interactive `pis` runs expose an image-owned `request_apt_packages` Pi tool. It submits one small, typed JSON proposal over a private Unix socket. The socket grants permission to **suggest**, not permission to change anything. Direct, print, RPC and custom-stdio launches do not expose this service.

The tool reports that nothing has been installed and requests an orderly Pi shutdown. After Podman exits, pis removes the container and checks that it no longer exists. It then closes the proposal service before prompting on the host terminal. The user must type a fresh random six-digit confirmation code; Enter or any other response declines.

Only the validated package list held in host memory is used after confirmation. No approval field, filename, shell command, configuration patch, URL, or generic command is accepted from the sandbox. Unknown action types and unknown fields are rejected. At most ten simple apt names and a bounded explanation are accepted; shell syntax, versions, terminal controls and bidirectional formatting controls are rejected.

Approval saves an additive `image.packages` change using the normal registry lock, stale-config check, validation and atomic write. Existing settings are retained. The next `pis` launch builds the new image; it does not automatically restart or resume the model. Decline makes no changes. If another process edited the configuration meanwhile, saving fails rather than overwriting it.

New projects start with `build-essential` and `python3` as visible, editable package defaults. Existing explicit package lists, including an empty list, are not migrated.

### Trust limits

The model can suggest inappropriate packages or misleading reasons. The reason is explicitly untrusted; the exact package names are what the user approves. Package installation can execute Debian maintainer scripts inside the image build. Confirmation does not mean a package has been audited.

This is not a defense against a malicious host user, kernel/container escape, or all terminal-emulator attacks. The sandbox may print misleading text while it runs. Real authorization happens in pis after the sandbox has been stopped, with a new confirmation challenge not supplied by the sandbox. Never approve solely because the model says an operation is safe.

## Future: git push (not implemented)

Keep this a distinct `git-push` action, not a generic `run_command` tool. A proposal must identify a repository, an exact commit and destination ref. Host validation must bind it to the registered project, resolve and display the actual remote URL, and reject external transports, remote helpers and unsafe URLs.

Git configuration and hooks in a shared repository are sandbox-controlled. Simply running `git push origin` on the host is **not safe**: hooks, `core.sshCommand`, credential helpers, URL rewrites, remote helpers and environment configuration can run host code or change the destination. A safe implementation needs controlled Git configuration, disabled repository hooks and helpers, tightly constrained transport/authentication, and an explicit credential policy. These details require a separate implementation and tests.

After stopping the sandbox, present the resolved destination, full commit hash and destination ref to the user. Push that exact object/ref (not a mutable branch name), verify it again, and never allow implicit force pushes. A later retry or a different action requires fresh approval. Host credentials must never be mounted into the sandbox.
