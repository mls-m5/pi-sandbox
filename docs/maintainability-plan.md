# Readability and maintenance cleanup

Status: approved incremental cleanup. Preserve observable behavior, project configuration, host/container boundaries and approval contracts. This is not a framework migration or permission to implement deferred LAN/TLS/shared-image work.

## Checklist (in priority order)

- [x] **Consistent formatting.** Pinned Prettier 3.10.1 as a development-only dependency and added format/format:check. Formatted production JS/MJS, browser CSS/HTML and GNOME JS in one mechanical pass. The user explicitly approved this one-time formatting of image-embedded files; fingerprints can change and next-start images may rebuild. Separate mechanical changes from logic refactoring. Preserve whitespace-sensitive content and test the real app module.
- [x] **Automatic syntax checks.** `scripts/check-syntax.mjs` discovers production/test JS/MJS/CJS and shell sources (including GNOME, env.sh and pi-launcher), skips dependencies/generated/hidden/symlink paths, and parses without executing them. Added discovery/non-execution/error tests. Replaced the hand-maintained package.json command chain with a dependency-free script that finds relevant source files, skips generated/dependency directories and checks the shell launchers as well. Keep npm run check as the normal entry point.
- [ ] **Shared terminal input.** Reuse hidden/visible terminal editing and lifecycle cleanup across web admin-password input, agent keys and API login. Retain caller-specific defaults, limits, piped-input rules, error messages and cancellation. Never echo secrets; restore terminal mode and remove signal listeners after success/failure.
- [ ] **Readable agent status calculation.** Replace deeply nested browser status expressions with a small pure function and focused tests; retain working/waiting/idle/aborted/error/offline semantics.
- [ ] **Shared test transport helpers.** Consolidate repeated local HTTP/WS fixtures and bounded wait helpers after identifying stable common behavior. Keep tests independent; do not hide security assertions or add an elaborate test framework.
- [ ] **Private JSON helpers (evaluate before extracting).** Compare API login, agent profile and other credential readers. Extract only genuinely common safe file-opening/size/permission checks, leaving credential formats, policies and errors explicit. Do not weaken O_NOFOLLOW, owner/mode, nlink, nonblocking or size checks.
- [ ] **Web server responsibility split.** Keep web/server.js as a stable composition entry point; consider focused session, agent-registration and routing modules with narrow interfaces. Preserve role separation, ticket ownership/proof/expiry, request correlation, backpressure and ambiguous-outcome behavior. No framework/microservices/DI container needed.
- [ ] **Browser responsibility split.** Make public/app.js a small coordinator; extract connection/pending commands and enrollment UI only where state ownership becomes clearer. Preserve selection/reconnection races, secret clearing and history independence. Do not create a file for every handler.
- [ ] **Container/image responsibility split.** Separate image recipe/build planning from launch/lifecycle orchestration before shared-image implementation. Audit every image-embedded source dependency and fingerprint effect; pure file moves/formatting must not casually trigger expensive image rebuilds on a nearly-full host disk.
- [ ] **Feature-oriented core structure (evaluate later).** Group project/config, container/image, auth, RPC and host approvals only after extracting real boundaries. Avoid a large file-move-only diff, deep directory hierarchies and generic services/controllers/models layers.
- [ ] **Documentation consolidation.** README for normal commands, development.md for the current map/gates, feature docs for contracts; clearly distinguish current behavior, historical investigations and deferred plans. Remove redundant stale claims without deleting pending user requests/security rationale.

## Working rules and verification

- Make small coherent commits at verified milestones; retain a clean distinction between formatting, refactoring and behavior changes. No promised percentage reduction until duplication is measured; more formatted lines can mean less maintenance effort.
- Runtime dependencies remain absent from the core. Tooling dependencies are development-only and pinned; optional ws stays under web/. No new framework/build pipeline is required.
- The user subsequently approved a one-time full production formatting pass, including image-embedded sources. Future formatting should use the committed convention to avoid repeated churn/rebuilds. No Podman builds, image/cache deletion or live/paid inference as smoke tests.
- Run npm run check after code changes; use the optional web suite for browser/transport changes. Existing fake-Podman, real local HTTP/WS and DOM-shim tests are useful gates, not proof of graphical layout, real-engine or LAN deployment correctness.
- Prefer behavior assertions over exact formatting/source-string assertions. Keep source guards where they actually enforce a security invariant, and make cosmetic CSS assertions whitespace-insensitive.

## Research informing the plan

- [Node.js Best Practices: component boundaries](https://github.com/goldbergyoni/nodebestpractices/blob/master/sections/projectstructre/breakintcomponents.md): organize by capability with explicit boundaries; adapt to this small CLI rather than copying an enterprise directory template.
- [Martin Fowler: refactoring external-service code](https://martinfowler.com/articles/refactoring-external-service.html): small behavior-preserving steps and deterministic tests; remove duplication in tests as well as production code.
- [Prettier rationale](https://prettier.io/docs/rationale): consistent mechanical formatting reduces review noise; formatting alone does not simplify underlying logic.
