# Claude Code in the pis sandbox (experimental)

This mode runs Anthropic's **unmodified official Claude Code**, not Claude models in Pi and not a subscription-token proxy. Pi remains the default. Claude Code uses its own subscription login and direct networking; Pi's Codex/API-key proxy is not involved.

## Start

Install official Claude Code **on the host** using [Anthropic's installation instructions](https://code.claude.com/docs/en/setup). The default host executable is `~/.local/bin/claude`. If installed elsewhere, set `PIS_CLAUDE_BIN` to its absolute executable path. pis does not download or run a host installer for you. Executables in registered project roots, extra mounts or sandbox storage are rejected for host login.

From a registered project, on the host terminal:

```sh
pis --login-claude               # Official browser sign-in, for this project
pis --agent claude               # Build image if necessary, then start Claude
pis --agent claude -- --continue # Explicitly resume Claude's last session
pis --agent claude -- --resume   # Claude's session selector
```

Use a Claude subscription, not `--console` API billing, in the login flow. No model call is made by pis during login. Sign-in still contacts Anthropic for authentication.

Set `"agent": "claude"` using `pis --edit` to make this project's default Claude Code. `--agent pi` or `--agent claude` overrides the stored choice for a single launch (also works with `--show`, `--check`, `--build`, `--rebuild`, `--bash` and `--exec`). Existing explicit choices are preserved. `credentials.env` must remain `[]`.

Claude starts **a new session by default**, unlike Pi's implicit continuation. `--fresh` therefore adds no Claude flags. Arguments after `--` are forwarded unchanged; do not put Pi-specific flags there when using Claude. Claude permissions and workspace-trust prompts are not bypassed.

For inspection without a conversation:

```sh
pis --agent claude -- --version
pis --agent claude -- auth status
pis --agent claude --bash
```

`--version`, `--help` and management commands do not require a stored login. Bash/exec do not require a login either, but see any credentials already in this agent's state. They use the selected agent's image and home. Claude print mode (`-p`) avoids a TTY, like Pi print mode.

## Credential flow and the weaker security boundary

**Real access and refresh tokens are readable and writable inside the Claude sandbox.** A malicious dependency, tool, prompt-induced command or other process with the same container user can steal them. Claude's own permission UI is not an isolation boundary between the CLI and shell commands. Treat this mode as less secret-isolating than Pi's host proxy. Normal container isolation still protects unmounted host data, subject to the host kernel boundary.

1. `pis --login-claude` takes this project's exclusive lock and starts official host `claude auth login` with a fresh host-only `CLAUDE_CONFIG_DIR` and working directory. It does not load the repository's settings, hooks, or existing sandbox login. Host Anthropic API keys, OAuth environment overrides, alternate endpoints and Node injection options are removed from this child environment.
2. After successful login, pis reads a bounded, private regular `.credentials.json` and copies `claudeAiOauth` plus the optional `oauthAccount` identity field from the native global config, not host settings, project trust, hooks, MCP servers, history or API keys. Existing sandbox preferences are preserved when updating that identity field.
3. A private original snapshot is kept at `$PIS_HOME/auth/claude-<id>.json` (default PIS_HOME: `~/.local/share/pis`). It is **not mounted**. The temporary host login directory is removed. Personal host `~/.claude` is not imported or mounted.
4. The working copy lives at `projects/<id>/claude-state/.claude/.credentials.json`. The entire separate `claude-state` home is mounted read-write at `/pis/home`, with `CLAUDE_CONFIG_DIR=/pis/home/.claude`. Pi's `state/` is not mounted in Claude mode, and Claude state is not mounted in Pi mode.
5. Claude can renew tokens and save them in its own persistent state. Startup **never recopies the host snapshot over renewed tokens**, and sandbox tokens/settings are never imported back into the host client.

Directories use mode 0700 and copied credential files mode 0600. Credential reads reject symlinks, hardlinks, nonregular files and oversized/nonprivate JSON. Credential write paths reject symlinked state directories and nonregular or hardlinked destinations. These checks are not a defense against a compromised host/kernel or arbitrary simultaneous host filesystem manipulation.

Logins are deliberately **per project**, not global: cloning one rotating refresh token across concurrently running projects can invalidate other copies. Do not use the retained host snapshot as another active login. Separate browser logins may still be subject to account/session policies at Anthropic. One login may work for a long time with automatic refresh, but indefinite validity is not promised.

If Claude reports an expired or invalid login, stop the sandbox and run `pis --login-claude` again on the host. This explicitly replaces the snapshot and working credential file but keeps conversation state. First-run onboarding or account/setup prompts may still appear; pis does not suppress or pre-approve them.

```sh
pis --logout-claude
```

Logout removes this project's host snapshot and current sandbox credential file under the project lock. It **does not revoke tokens at Anthropic**, delete sessions/backups, or scrub credentials that sandbox commands copied elsewhere. Use Anthropic's account controls if tokens might have leaked.

## Image and unavailable Pi features

Claude images add pinned `@anthropic-ai/claude-code@2.1.318` to the existing image. npm lifecycle scripts are disabled; the specific official package's `install.cjs` is then run explicitly to place its platform-native binary, and `claude --version` checks installation during the build. The binary is unmodified. Runtime `DISABLE_UPDATES=1` keeps updates controlled by image changes/rebuilds. No real credentials are supplied to builds.

Pi packages/extensions are not Claude plugins. Claude launches do not expose Pi's apt/Git proposal socket or automatic post-approval restart flow, and never start the configured Pi credential proxy. Existing Pi proxy settings are kept unchanged for switching back to Pi. Host `ANTHROPIC_*` and `CLAUDE_*` variables are stripped from Podman subprocess environments, not forwarded into the runtime. The runtime receives only its fixed Claude configuration directory and update policy.

## Verification and limits

Fast tests use a fake official-login subprocess and a fake Podman CLI; they verify selection, image generation, mount isolation, no Pi proxy/approval socket, private credential copying, preserving sandbox refreshes, locking, failure paths and rejection of unsafe files. They make no real login or model requests.

An opt-in real-Podman test builds the image, runs the real native binary **only with `--version`**, and checks writable persistent fake login state with runtime networking disabled. Run `npm run test:integration` on a suitable host. Merely having this test in the repository does not mean it was run in the sandbox.

**Not yet verified end to end:** real host subscription login, initial Claude onboarding with the copied credential, native binary execution on the target host/container, interactive sessions and actual refresh-token rotation. No paid/live model calls are used as smoke tests. If Anthropic changes its file format or login behavior, this integration may need updates; do not fall back to sharing host home or mounting credential directories directly.

References: [authentication and Linux credential storage](https://code.claude.com/docs/en/authentication), [CLI reference](https://code.claude.com/docs/en/cli-reference), [third-party hosting and credential rules](https://code.claude.com/docs/en/legal-and-compliance).
