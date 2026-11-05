# Working on pis

Start with **[docs/handover.md](docs/handover.md)** for the recent implementation, design decisions, host/container boundary, verification limits and pending requests. Use README.md for normal setup and docs/host-actions.md for approval/security contracts.

- This is a dependency-free Node.js ES-module CLI. Run `npm run check` after code changes.
- Fast tests make no paid model calls. Real-Podman integration tests are opt-in and use fake upstreams. Do not make paid/live model requests or external Git pushes as casual smoke tests.
- In a sandbox the shared repository is writable, but host credentials/config, GNOME and Podman control are not expected to be accessible. Do not bypass this by mounting host home, agents or container-engine sockets.
- `request_apt_packages` and `request_host_git` are image-owned tools for **proposals**. Only the host can approve. Git currently allows exact-commit pushes only; do not turn this into a shell or unrestricted Git-command interface.
- Preserve explicit project configuration. Never print auth files, API keys, full process environments or credential-bearing URLs.
- Pending requested feature: host-global Git name/email defaults in the sandbox; see docs/git-identity-plan.md. It is not implemented yet.
- Update documentation when changing defaults, approval flow, restart notifications, cleanup policy or credential handling. Clearly distinguish tested behavior from plans and host-local changes.
