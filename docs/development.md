# Development map and verification boundaries

Start with `AGENTS.md` for contribution/security rules and `README.md` for operation. This is a compact durable index, not a session transcript or per-agent handover. Keep feature contracts in their linked documents, and use `git status`/`git log` for current work rather than reproducing commit diaries.

## Feature/source map

| Area | Contract/reference | Main implementation |
| --- | --- | --- |
| Project configuration/normal sandbox lifecycle | [Design](design.md), [README](../README.md) | `src/config.js`, `src/store.js`, `src/container.js` |
| Codex accounts/routing versus continuation | [Codex](codex.md), [quota wait](codex-wait.md) | `src/codex-auth.js`, `src/codex-accounts.js`, `src/codex-auto.js`, `src/runtime/codex-auto.mjs` |
| Credentials/provider isolation | [Proxy](proxy.md), [Claude exception](claude-code.md) | `src/proxy*.js`, `src/api-auth.js`, `src/claude-code.js` |
| Typed proposals/host approval | [Host actions](host-actions.md) | `src/apt-requests.js`, `src/git-push.js`, `src/runtime/request-apt.mjs` |
| Managed updates/backup/rollback | [Implemented updates](updates.md), [wider plan](updates-plan.md) | `src/updates.js`, `src/update-backup.js`, `src/runtime/verified-install.mjs` |
| Shared image layout/storage limits | [Image storage](image-storage.md), [historical diagnosis](image-storage-plan.md) | `containerfile()`/`imagePlan()` in `src/container.js` |
| Pruning/conservative lock recovery | README cleanup/lock sections | `src/prune.js`, `src/locks.js`, `src/unlock-worker.js` |
| Local web controller, host-only connectors, bounded text history | [Web setup/security/diagnostics](web-control.md), [RPC contracts](pi-rpc.md), [remaining design](web-control-plan.md) | `web/`, `src/pi-rpc.js`, `src/rpc-history.js`, `src/project-rpc.js` |
| Token-free quota simulator | [Dummy backend](dummy-agent.md) | `src/dummy-agent.js`, `bin/pis-dummy*.js` |
| GNOME quota display/install | [GNOME README](../gnome-codex-usage/README.md) | `gnome-codex-usage/` |

## Current web/history issue and implemented mitigation

Host diagnostics confirmed a real Pi project starts/answers state/registers successfully, but `get_messages` exceeded the ordinary 4 MiB native record cap (`rpc_record_too_large`). That previously faulted the adapter, causing later state requests to fail too. Dummy end-to-end state/history/prompt reads were confirmed by the user's safe traces; those successful traces are not a general graphical-browser certification.

The web UI automatically opens the first roster agent. Opening/reopening an agent or reconnecting reads **state first**, follows live events and automatically requests bounded recent history once. Fresh idle state enables prompt/stop independently while history is pending; failures remain nonfatal with manual **Hämta senaste historik** refresh/retry. Settlement checks remain state-only: no history polling, failure retry loop or prompt replay. State readiness and displayed-history completeness are separate; history failure alone must not prevent valid idle prompt/stop control. The requested native history reader retains at most 100 messages/1 MiB of raw recent bodies before existing 256 KiB projected-view limits. It uses a separate bounded streaming path; an over-limit history read drains to LF and rejects only that read with `rpc_history_limit`. Ordinary malformed/unsolicited/oversized non-history records still fault closed. Full native history may still traverse the pipe on each automatic/manual history request; there is no native paging command or full session-file reader. Saved session/context/compaction policy are unchanged. See [the detailed parser limits](pi-rpc.md).

The user reports the updated web flow now works. This is useful host feedback, not exhaustive verification of every giant-history edge case or production container lifecycle. No need to reset auth, delete transcripts, recreate a project or increase record caps without bounds.

Assistant reply text has bounded fixed-DOM Markdown (headings/emphasis/code, lists, disabled task checkboxes, pipe tables and explicit HTTP(S) links); user/thinking/tool content stays literal. Content text uses textContent; links alone get separately validated href/new-tab/no-opener/no-referrer properties and require a user click. Raw HTML, images, unsafe URL schemes, remote highlighting and arbitrary attributes stay disabled. Checkboxes cannot mutate agent work. The implementation/security contract is in docs/web-control.md; formatting tests run without model calls.

Agent activity now has a text-labelled work/wait spinner (CSS respects reduced motion); idle is explicitly not task success. Tool call IDs/results are retained in the bounded client projection and merged into one chat card: dashed running, blue completed, red reported error, neutral unknown if completion was missed/interrupted. Result text stays literal, arguments omitted. Agent-end alone does not stop the activity indicator; settlement does. See docs/web-control.md for history/live limits and verification gaps.

Berget model overlays now use `src/berget-models.js`: one bounded unauthenticated public GET per launch, fixed endpoint/no redirects, five-second deadline, compatible streaming/tool chat filtering and a four-chat-model bundled fallback. `discoverModels: false` opts out; Berget-only `modelOverrides` supply explicit verified metadata. The public response omitted context/output limits, so local default output budgets are not certified provider limits; EUR prices are not copied as USD. GLM's default is now 320000 context (Berget GA announcement) / 65536 output (local reasoning+answer budget, increased from 8192 after reported length truncation). Valid discovered limits then explicit overrides win. Effort-control metadata is not proof that server reasoning is off; no unverified Berget effort parameters were added. An injected-fetch Pi AI 1.5.2 probe confirmed 65536 reaches the wire and synthetic reasoning_content parses as thinking without external requests; image pin remains 1.5.0 and live Berget behavior is still unverified. Read docs/proxy.md before changing this boundary. Fake upstreams disable public discovery unless a catalogue-fetch fake is injected.

Standalone local enrollment is implemented in `web/agent-cli.js`, `web/agent-profile.js`, `web/secret-input.js` and admin-only server routes. `pis --server --standalone` starts no runtimes; the GUI creates/revokes in-memory registrations and shows keys once. `pis --connect register/run/forget` manages host-private profiles outside sandbox mounts; preflight verifies identity before runtime launch. Ordinary reconnect preserves local work; auth rejection stops retrying old keys without killing local Pi. Server restart invalidates sessions and registrations, requiring explicit replacement. See [web-agents.md](web-agents.md) for laptop steps, safety contracts and verification. No LAN/TLS/container-isolation/persistent-server functionality is implied.

## Development checks

```sh
npm run check
npm run test:web       # optional ws package installed under web/
PIS_PI_PACKAGE=/path/to/installed/pi-package npm run test:rpc-compat
npm run test:integration  # explicitly opt-in real rootless Podman/fake services
npm run test:storage      # separate, disk-heavy legacy/new image benchmark
```

- During extended-Markdown verification, one full parallel run failed the pre-existing dummy-quota assertion in `test/web-app.test.js` (`resumes` was 2 instead of 1, before the new Markdown event/assertions). The isolated app test and a complete rerun passed; no quota/resume behavior was changed or assertion relaxed. Treat this as an intermittent test/runtime issue to investigate if it recurs, not proof that quota resumption is universally race-free.
- Ordinary checks use fakes/local sockets/subprocesses, with **no live/paid model calls**. Without optional `web/node_modules/ws`, web transport/CLI tests explicitly skip; pure helpers and core checks remain available.
- Latest ordinary result after independent local enrollment: **309 tests, 298 passed, 11 skipped** with the optional web dependency installed. Keep this number current only when reporting a fresh check, not as a permanent coverage guarantee.
- The isolated no-model RPC state/history/EOF probe passed against installed **Pi 1.5.0** after this parser change, with no network attempts. Earlier probes ran 1.5.2; source image pin is still 1.5.0. The probe does not exercise giant real session records or container lifecycle.
- Full rootless Podman image/storage/update/project RPC tests were **not run in the development sandbox**. The new storage layout has unit/fake-engine tests and an opt-in host benchmark, **no measured physical saving** yet. Read its free-space guard/cleanup limits before running it.
- App tests run the actual browser module through real local HTTP/WebSockets in a DOM shim, not a graphical browser. Host reports confirm some real browser/agent flows; full CSP/cookies/layout/accessibility/mobile and crash/long-running lifecycle still need verification.
- Real-account exhaustion/refill/automatic continuation and complete Pi TUI approval/rebuild/resume/selected-branch behavior remain broader host gates. The user reported actual account switching working, but do not manufacture provider-wide certification from it.

## Remaining requested work / priorities

**Deferred at the user's request until their tokens refill:** [shared program image with separate agent containers](shared-base-image-plan.md). Manage common installed packages through an explicit host edit workflow (suggested `pis --edit-base`, not implemented), retain separate project state/mounts/containers, and review migration/global approval scope before changes. Record only for now; wait for the user to resume rather than starting builds or automatic work.

1. Host verification of bounded automatic history on opening agent views and experimental real-project web lifecycle. Preserve fixed safe diagnostics; never request auth/state folders or HARs to debug routine failures.
2. Separate least-privilege **server isolation** and protected enrollment/IPC. Current web server/controller/connectors are host Node code, not an OS sandbox. Same-host independent registration/CLI now works with ephemeral server state and private client profiles; TLS/LAN, multi-computer deployment, persistent server registration and server credential maintenance are not implemented.
3. A bounded supervisor/continuation policy is desired later. Current web control is observation/manual prompting/stop, not an unattended supervisor; `idle` is not goal completion. Production `--auto-wait-codex` remains terminal-only; the dummy has a separate simulator.
4. Remote apt/Git approvals remain deferred. Existing terminal-only stopped-container/exact-action authorization must not be weakened or replaced by chat/dialog confirmation.
5. [Host-global Git identity defaults](git-identity-plan.md): requested, not implemented. Copy only missing `user.name`/`user.email`, never a whole gitconfig, preserving explicit choices.
6. Verify image-sharing/actual allocated bytes and real managed build/probe/activation/rollback after the layout change. Never sweep arbitrary cache layers, Buildah workspaces, backups, state or toolchains as a shortcut. `prune.lock` joins existing conservative `--unlock`; no automatic lock stealing.
7. Mistral subscription/browser auth is a wish without a selected protocol; API-key login is implemented independently. Git/watchdog image sources/preparation and jointly budgeted continuation need separate review (see updates plan); no silent installation/enabling.
8. GNOME graphical refresh/reload/stale behavior and full host Git auth rejection/recovery still need manual coverage. GNOME reports the selected account only; missing slots/weekly-primary responses are legitimate provider shapes, not proof that the second account disappeared.

## Host-local operational pitfalls

- PATH can point to an older checkout or Node. Inspect `command -v pis` / `node --version`, not full environments/auth files. `env.sh` affects only its current shell; a bundled Node can itself be too old. `pis --server` has an intentional Node 24 npm fallback; other commands/GNOME usage need a compatible launcher (>=22.19).
- GNOME deliberately calls `~/.local/bin/pis` because Shell may not inherit terminal PATH. Its extension is an installed copy: use its installer and reload appropriately (Xorg shell restart versus Wayland logout/login). No host launcher/session state is automatically present in a sandbox.
- Host home, SSH agents, Podman control and provider credentials are not available in a normal development sandbox. Claude's project-specific copied tokens are the documented exception, not permission to mount host originals.
- The old CNI dnsname warning was a host-local retired test network issue, not an auth/proxy problem; recovery details are in [known issues](known-issues.md).
- Host confirmed commit 7f31e7a9ab6d51ab04a5bb6e16b4d744a36d9e58 pushed to main (GLM budget tuning, after earlier web/catalogue milestones). Earlier proposal validation failures were not user rejections: the tool's `reason` is limited to 500 characters. Keep future reasons short, verify exact HEAD and require fresh host approval for later commits; never repeat a confirmed push.
