# Working on pis

Start with **[docs/handover.md](docs/handover.md)** for the recent implementation, design decisions, host/container boundary, verification limits and pending requests. Use README.md for normal setup and docs/host-actions.md for approval/security contracts.

- The core is a dependency-free Node.js ES-module CLI; optional web dependencies are isolated in `web/`. Run `npm run check` after code changes.
- After substantial changes, proactively create small, coherent, descriptive commits at verified milestones rather than accumulating a large uncommitted tree. Inspect `git status`/diffs first; preserve others' work and never stage credentials, generated dependencies or unrelated files. Clearly identify unfinished scaffolding and verification gaps instead of presenting it as finished functionality.
- After committing substantial requested work, propose a push via `request_host_git` for the exact full commit and intended branch, subject to host approval. Never push directly or treat an earlier approval as permission for a new push. If the proposal tool is unavailable, ask the user to approve/perform the host push. Report a push as successful only after host confirmation; do not duplicate an already confirmed push.
- Fast tests make no paid model calls. Real-Podman integration tests are opt-in and use fake upstreams. Do not make paid/live model requests or external Git pushes as casual smoke tests.
- In a sandbox the shared repository is writable, but host credentials/config, GNOME and Podman control are not expected to be accessible. Experimental Claude Code mode is an explicit exception: its separate writable state contains a project-specific copy of real subscription tokens; host originals and personal host Claude state are never mounted. See docs/claude-code.md. Do not bypass this by mounting host home, agents or container-engine sockets.
- `request_apt_packages` and `request_host_git` are image-owned tools for **proposals**. Only the host can approve. Git currently allows exact-commit pushes only; do not turn this into a shell or unrestricted Git-command interface.
- Preserve explicit project configuration. Never print auth files, API keys, full process environments or credential-bearing URLs.
- Pending requested feature: host-global Git name/email defaults in the sandbox; see docs/git-identity-plan.md. It is not implemented yet.
- Update documentation when changing defaults, approval flow, restart notifications, cleanup policy or credential handling. Clearly distinguish tested behavior from plans and host-local changes.
