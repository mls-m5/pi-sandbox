# Readability and maintenance cleanup

Status: the approved bounded cleanup is implemented and verified with offline checks. Further extraction is an evaluation, not a requirement to split every handler or move files for their own sake. Preserve observable behavior, explicit configuration, sandbox/credential boundaries and approval contracts. This is not a framework migration or permission to implement deferred infrastructure.

## Implementation map

| Work | Current result / durable reference |
| --- | --- |
| Consistent formatting | Pinned development-only Prettier 3.10.1; production JS/MJS/CSS/HTML and GNOME sources follow one convention. The approved one-time image-source pass can change fingerprints; avoid repeated formatting churn. |
| Automatic syntax checks | `scripts/check-syntax.mjs` discovers relevant JS/MJS/CJS/shell sources, skips dependencies/generated/hidden/symlink paths and parses without executing them. Discovery/non-execution/error tests protect the boundary. |
| Shared terminal input | `src/terminal-input.js` owns editing, UTF-8 decoding, terminal restoration and listener cleanup. Callers retain distinct defaults, limits, piped-input/cancellation and credential policies. See [the development map](development.md). |
| Readable activity policy | `web/public/activity.js` has ordered pure status decisions. Working/waiting/idle/aborted/error/offline remain distinct; idle is not success. See [web control](web-control.md). |
| Shared transport test primitives | `test/fixtures/transport.js` centralizes loopback startup and bounded waits, retaining caller deadlines/messages. Security assertions and specialized WS queues remain explicit in tests, not hidden behind a framework. |
| Web server responsibility split | `server-sessions.js` owns session bookkeeping; `server-registration.js` owns bearer/proof/key logic; `pairing.js` owns bounded request/approval/claim state; `server-pairing.js` owns its HTTP role/schema gates. `server.js` remains composition, outer Host validation and transport/routing owner. See [agent enrollment](web-agents.md). |
| Browser responsibility split | `enrollment-ui.js`, `pairing-ui.js` and `pending-commands.js` own their bounded UI/correlation state. `app.js` keeps connection, selection, readiness and history coordination together; no whole-app context/service locator was introduced. See [web contracts](web-control.md). |
| Container/image responsibility split | `src/image-plan.js` owns recipe/context/fingerprint planning with compatible container exports. Build execution and lifecycle remain in `container.js`. Five ordinary/managed plans compared exactly across extraction; see [dependency/fingerprint contracts](image-storage.md#planner-and-lifecycle-boundary). No Podman build or physical saving is claimed. |
| Documentation consolidation | README is the command entry point; development.md indexes current code/checks/priorities; feature docs hold contracts. Current local code-approval/subagent behavior is separated from deferred TLS/LAN/isolation plans. Historical investigations remain labelled rather than replacing current contracts. |

## Evaluated extractions deliberately not performed

- **Private JSON helper:** API, agent-profile, Codex and backup readers share only small descriptor/read skeletons but have distinct permission/import, missing-file, size (`<64 KiB` versus `<=8 KiB`), schema and error policies. Keep these visible instead of normalizing them through generic options. Any future helper must retain O_NOFOLLOW/O_NONBLOCK, descriptor fstat, owner/mode/nlink/regular-file checks, exact limits and cleanup. The new default-origin reader likewise keeps an explicit private-file policy.
- **More WebSocket/connection modules:** the existing server routing and browser selection/history coordination share generation, sequence, pending and readiness ownership. Further extraction without a clearer interface would spread mutable state across callbacks. Revisit for a concrete capability/testability benefit, not line-count reduction. Current focused boundaries are the accepted milestone, not a claim that every remaining function is small.
- **Feature-folder migration:** project/config, image/container, auth, RPC and host approvals already have source/contract boundaries indexed in development.md. A large flat-to-nested file move adds churn and risks relative image-embedded dependencies without a demonstrated maintenance benefit. No generic services/controllers/models layer or shared-base-image work is started.

## Verification and parallel-worker trial

Run `npm run check` after code changes and `npm run test:web` for browser/transport changes; `npm run format:check` checks production formatting. Fresh counts and opt-in gates live in [development.md](development.md#development-checks), not permanently duplicated here.

A bounded two-Luna-worker Git worktree trial produced disjoint test patches from a clean committed base. Supervisor review, explicit patch transfer and combined tests passed. It filled regression gaps for separate-session logout, idle heartbeat expiry, exact enrollment-key deadline, matching clear events and pagehide secret clearing. See [worktree setup, reload requirement and separation limits](extensions-plan.md#parallel-worktrees-bounded-sandbox-trial). The tested base-directory setting is local sandbox configuration, not a universal pis default or separate OS isolation. Managed worktrees may be retained for session resume; never delete uncaptured changes as cleanup.

Remaining host gates include real graphical-browser CSP/cookies/layout/accessibility/mobile behavior, long-running/crash lifecycle, real rootless Podman project cleanup, and new-image foreground/background subagent execution. Offline fake-engine, local HTTP/WS and DOM-shim results are evidence for their tested boundaries, not certification of LAN/TLS or provider behavior.

## Working rules

- Keep formatting, behavior changes and responsibility refactors in coherent verified local commits; the user handles pushes manually. Do not promise a percentage reduction without measuring duplication.
- Core runtime dependencies remain absent. Development tooling is pinned; optional `ws` stays under `web/`. No new framework/build pipeline is needed.
- Preserve explicit package/config choices and approval/cancellation semantics. Never echo secrets, silently enable delegation/spending or add host mounts/credentials to make a test pass.
- No paid/live inference, Podman builds or image/cache deletion as smoke tests. Runtime/embedded-source changes can require next-start rebuilds; audit before moving them.
- Prefer behavior assertions. Retain source guards where they enforce security; cosmetic formatting assertions should not be whitespace-sensitive.
- Separate requested infrastructure/features remain in [development priorities](development.md#remaining-requested-work--priorities), including TLS/LAN, server isolation, supervisor/remote approvals, host Git identity and deferred shared-base-image design.

## Research informing the plan

- [Node.js Best Practices: component boundaries](https://github.com/goldbergyoni/nodebestpractices/blob/master/sections/projectstructre/breakintcomponents.md): adapt capability boundaries to this small CLI, not an enterprise template.
- [Martin Fowler: refactoring external-service code](https://martinfowler.com/articles/refactoring-external-service.html): small behavior-preserving steps and deterministic tests; reduce duplication in tests as well as production.
- [Prettier rationale](https://prettier.io/docs/rationale): mechanical consistency reduces review noise but does not by itself simplify logic.
