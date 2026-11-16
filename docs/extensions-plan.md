# Image extensions and configuration completion

**Implemented:** project JSON install sources, image-baked npm packages, automatic loading, a source inventory command, JSON defaults/hints, and a generated editor schema. An opt-in [managed Pi/npm updater](updates.md) now stages exact top-level integrity-checked candidates for later-launch activation and image rollback; full transitive locks and Git/local builds remain future work. The source baseline pins Pi 1.5.0; see [the upgrade and remaining maintenance design](updates-plan.md) for verification, watchdog requirements and the distinction between managed channels and explicit pins.

## Install by source, not by path

Pi normally installs packages with:

```sh
pi install npm:pi-web-access@0.40.0
```

Put that same install specification in the project's JSON instead:

```json
{
  "extensions": [
    "npm:pi-web-access@0.40.0"
  ]
}
```

This is a fragment: retain the rest of `project.json`. Run `pis --edit`, save, and start `pis` or run `pis --build`. An extension source change changes the image fingerprint automatically. The next launch cannot silently reuse an image with different configured sources.

The build runs Pi's own installer inside Podman with `PI_CODING_AGENT_DIR=/opt/pis/agent`. npm lifecycle scripts are disabled. No source package installation, extension factory, or npm script is executed by the host wrapper. Runtime provider credentials and host Pi configuration are not supplied to the build.

Installed resources remain in the image under `/opt/pis`. An image-owned bootstrap supplies their local package roots to Pi's extension loader, so package manifests and Pi's API aliases work normally without runtime installation. Extensions are activated through these arguments; configured `pi-subagents` additionally gets its packaged skills directory explicitly forwarded. Other packages' skills and all package prompts/themes remain excluded. The `pi` command inside `pis --bash` uses the same bootstrap.

Packages are executable trusted code. They run with Pi's container permissions, not as host plugins. Package source/version pinning is not an approval or security boundary against malicious package code.

## Defaults and inventory

The default image sources are:

| Source | Purpose |
| --- | --- |
| `npm:pi-web-access@0.40.0` | Web search, source checking, content fetching, and stored-result retrieval |
| `npm:pi-subagents@0.88.1` | Explicitly invoked Pi child-agent delegation and workflows |

The former `pi-usage-bar-focus` package is intentionally not a default because its Codex percentage display is unreliable. Quota display is provided by the host-side `gnome-codex-usage/` extension instead.

Host inventory observed while implementing this feature also included `npm:@beyona/pi-zai-usage@1.1.0`. It overlaps with the usage bar, so it is an inert example rather than another enabled default. Host settings are not scanned or imported automatically on startup.

```sh
pis --extensions-list       # Configured image sources; does not build
pis -- list                # Image sources, then additional sandbox-state packages
pis --show                 # Full effective project configuration
```

Use `"extensions": []` to opt out. Missing fields receive the current defaults (`pi-web-access` and `pi-subagents`); explicit existing arrays are never appended to by normal loading or ordinary builds. Removing one entry keeps it removed, including on later configuration loads. Changing the program's defaults does not upgrade explicitly stored package versions.

### Pi subagents

New projects and configurations with a missing `extensions` field include `npm:pi-subagents@0.88.1`. The package declares Pi >=1.2; the image Pi baseline is 1.5.0. On startup the bootstrap loads only its extension entry point and forwards its packaged `skills/` directory as an explicit `--skill` resource. It does not load package prompts or themes. `--no-skills`/`-ns` suppresses that skill forwarding, while `--no-extensions`/`-ne` suppresses all baked resources. The package itself does not automatically launch children; delegation remains a model/tool decision and does not authorize spending or change the parent model.

Existing project arrays are not automatically migrated or appended to, including `extensions: []`. To opt an existing project in, run `pis --rebuild-defaults` on the host, or use `pis --edit` and add `"npm:pi-subagents@0.88.1"` to its existing `extensions` array, then save and launch/rebuild. Do not replace other selected packages unintentionally. Configuration edits change the image fingerprint; changes to the runtime bootstrap also affect the fingerprint, so the next start may rebuild even for projects with older explicit arrays.

Pi's npm child resolver selects the Pi package root from the actual Pi CLI entry point (rather than the `pi` wrapper), and the image wrapper resolves foreground `pi` launches directly to `/usr/local/bin/pis-pi-real`. The npm Pi child/peer-SDK execution paths have been inspected, but foreground/background execution has not been validated in a real image/container. Do not infer standalone Pi behavior from this npm setup. No host state, credentials, or Podman access is added for children. This availability change applies to Pi sessions only, not Claude Code mode.

### Explicit adoption and forced rebuild

```sh
pis --rebuild-defaults
pis --project PROJECT_ID_OR_NAME --rebuild-defaults
```

This is an explicit opt-in for the selected configured **Pi** project, including an existing `extensions: []`. It adds current default sources only for package names not already present; custom packages, source order and existing version pins win. It does not reset the rest of the project configuration or update existing pins. Normal `--build`, `--rebuild` and configuration completion keep their previous preserve-explicit-values behavior.

The command acquires the normal project lock, verifies the local rootless engine, then saves additions through the registry lock and stale-config check before a `--no-cache` build. A busy project or engine check failure makes no extension addition; concurrent config edits are rejected rather than overwritten. A subsequent build failure retains the explicitly saved additions for retry. Like `--rebuild`, it builds the declared baseline rather than activating a managed candidate; changing configured sources naturally changes managed recipe identity. It does not start an agent, send a prompt, purge arbitrary caches or change the running sandbox. Run it on the host: nested Podman remains unavailable in the tested development sandbox, and uncached builds need disk/network budget.

## Parallel worktrees: bounded sandbox trial

Eligible Pi launches with configured `pi-subagents` now prepare a private `worktrees` directory under `PI_CODING_AGENT_DIR` (normally `/pis/home/.pi/agent/worktrees`) and provide it through `PI_SUBAGENTS_WORKTREE_DIR` in the spawned Pi environment. The parent environment and extension config are never rewritten. This selects native allocation for the otherwise implicit provider choice; it does not start workers or make every delegation a worktree.

Explicit `worktreeBaseDir`, `PI_SUBAGENTS_WORKTREE_DIR`, or `worktreeProvider: "auto"`/`"worktrunk"` are preserved. Explicit `native` without a root can use the new default. Disabled extensions, missing subagents, Claude/non-Pi commands, management commands and help/version/list/export invocations do not prepare the directory. `--no-skills` alone still allows the extension/default; flags after `--` are prompt text, not opt-outs. Existing directory permissions are not changed; unsafe parents/configs or nonprivate default roots fail with a fixed error. Existing config is read through a bounded no-follow/nonblocking regular singly-linked descriptor (64 KiB cap), not a pathname read followed by replacement.

This deliberate bootstrap behavior changes image fingerprints and can cause a next-start rebuild, even with an older explicit extension list; it does not rebuild running images or reclaim caches. Unit tests and an offline installed-0.88.1 provider-resolver probe passed; new-image startup/foreground/background child execution still needs the opt-in real-Podman host gate.

The earlier two-worker trial used a manual configuration because the package's own unconfigured default is a `worktrees` sibling of the repository, whose parent may be outside the writable project mount. Failed allocation stopped before agent work rather than silently sharing the main checkout.

For an already-running session/older image needing a manual override, inside the Pi sandbox merge this setting into its existing `$PI_CODING_AGENT_DIR/extensions/subagent/config.json` (normally `/pis/home/.pi/agent/extensions/subagent/config.json`), retaining other explicit values:

```json
{
  "worktreeBaseDir": "/pis/home/.pi/agent/worktrees"
}
```

Use a writable directory outside both the project checkout and the extension directory. Reload Pi (`/reload`) after changing it: the already-loaded extension retained its previous value in the trial. That manual override was a tested **local configuration**; new eligible image launches now receive the environment default above, without editing that file. No host-directory permission change is made. Do not mount host home, expose credentials or broaden container privileges to fix allocation.

The tested workflow uses explicit Luna workers with `worktree: true`, a clean committed base, one writer per worktree and disjoint test-file responsibilities. Workers validate without committing; the supervisor checks handoff base commits and file scope, reviews captured patches, applies them explicitly and runs the combined tests before a local commit. No automatic merge/push to `main` is enabled. Generated dependency links must not enter patches. Missing optional test dependencies mean skips, not transport/browser verification.

The trial confirmed separate Git branches/working directories, unchanged main checkout while workers ran, and conflict-free patch transfer. It gives **working-tree separation within the same sandbox**, not distinct OS/container/credential isolation. Worktrees share Git metadata and can still interfere with refs/config/other accessible files; instructions and patch review remain necessary. Separate per-agent containers, mount design and project-lock interactions need a later reviewed design, not an assumption that Git worktrees provide a security boundary. Paths under `/pis/home` are container-local: the host must not assume those worktree paths are directly usable, or prune their shared Git registrations while workers/retained sessions still depend on them.

Managed handoffs may preserve completed worktrees for retained-session resume. Inspect their manifests and use the extension's reviewed cleanup/discard flow; never force-delete uncaptured changes or sweep arbitrary worktrees. Core tests and DOM-shim/loopback tests are useful gates, not real Podman or graphical-browser certification.

## Supported specifications

- `npm:package-name`
- `npm:package-name@1.2.3`
- `npm:@scope/package-name@1.2.3`
- `npm:package-name@canary`

Exact versions are recommended. Unversioned packages and tags resolve during image creation, not each launch; use `pis --rebuild` or opt-in [managed updates](updates.md) to refresh them. npm's lockfile remains in the image, but clean builds do not yet have a host-managed transitive dependency lock.

Duplicate package names—even with different versions—are rejected. Shell fragments, arbitrary URLs, credentialed URLs, Git sources, and local paths are rejected. Git/local source builds are future work; the first implementation deliberately supports the npm sources used by the chosen defaults.

Packages must ship usable Pi entry points. Lifecycle scripts are disabled; if a trusted package needs extra compilation, use explicit `image.extraInstructions` rather than executing scripts on the host.

## Configuration maintenance

The wrapper completes the selected project's configuration on launch, check, show, or edit. Project listing/discovery does not rewrite every other registered project.

Completion:

1. Adds missing fields and context-appropriate defaults, without overwriting explicit values.
2. Adds inert examples for alternate credential modes and additional extension sources.
3. Adds readable `hints` for credentials, extensions, mounts, and image customization.
4. Generates `project.schema.json` beside `project.json`, referenced through `$schema`, for JSON-aware editor descriptions/completion.
5. Saves formatted JSON with two-space indentation and a trailing newline under the registry lock.

The same completion runs after `pis --edit`, before validation/save. Invalid edits retain the previous valid file. New fields in a selected proxy mode appear automatically: API-key providers now select matching saved login profiles automatically; no keyEnv is added (legacy active fields are rejected with migration guidance). Codex retains OAuth and model/request-limit defaults. If `credentials.proxy` was deliberately absent, it stays absent; alternative modes are examples, not silently activated permissions.

Identity fields are never guessed or rewritten. Unknown fields and malformed types still fail validation rather than being discarded. `examples` and `hints` never execute commands, share directories, or pass credentials. Clearing an array means disable it; deleting a field requests its default again.

## Proxy compatibility

### Codex usage bar

The usage extension normally reads an OAuth `access` field and fetches a hard-coded ChatGPT usage URL. The sandbox auth overlay exposes an additional **synthetic** `access`/account field while keeping Pi's `api_key` credential type, preventing in-container OAuth refresh.

A container-only Node fetch adapter redirects exactly authenticated GET `https://chatgpt.com/backend-api/wham/usage` requests to the local relay. Other URLs are untouched; missing/wrong capabilities fail closed for that endpoint. No general HTTP forwarding is added.

The host adds real authentication/account headers, refreshes on the host if needed, and returns only numeric primary/secondary quota windows. Email, account ID, plan details, and arbitrary upstream fields are discarded. Quota polls count toward the proxy request budget. Vendor status pages are fetched publicly by the extension without credentials and require ordinary container egress; their UI rendering is not validated by the headless integration test.

### Web Access

For installed `pi-web-access`, startup fills missing sandbox `web-search.json` values:

- `openaiUseProviderBaseUrl: true`
- `openaiSearchProviders: [the selected proxy provider]` when proxy mode is active
- `workflow: "none"`
- `autoOpenBrowser: false`

Existing explicit settings are preserved; malformed JSON is not overwritten. In particular, an existing explicit `openaiResponsesUrl` or disabled provider-URL reuse may need manual adjustment. Remove a conflicting endpoint override to use the wrapper defaults. No host web-search configuration or credentials are copied.

The Codex model overlay uses the full local Responses URL so provider-URL reuse retains `/backend-api/codex/responses` rather than selecting OpenAI's public host. Hosted search goes through the same model allowlist and request budget as ordinary model calls. If a model allowlist is configured, include the package's selected search model or set `openaiSearchModel` in sandbox web settings.

Web Access can also use its keyless providers and normal network fetches. Its third-party services, optional paid providers, privacy rules, and browser/video dependencies remain its own features; installing it does not mount host browser profiles or provide third-party keys. No curator/browser port is published automatically.

## Debugging and manual extensions

```sh
pis -- --no-extensions                 # Suppress baked and discovered extensions
pis -- --no-extensions -e ./probe.ts    # Explicit user -e still works
pis -- install npm:some-package@1.2.3  # Manual install into writable project state
pis -- remove npm:some-package        # Remove its manual declaration
```

Manual packages and project-local extensions retain Pi's normal trust/discovery behavior. The wrapper does not auto-approve repository resources. Avoid declaring the same package both in image JSON and manual Pi settings; duplicate extension/tool registration can conflict. Removing a manual install does not remove the immutable image package—edit the JSON and rebuild instead.

## Verification and remaining work

Fast tests cover source parsing/injection rejection, configuration completion, schema emission, preserving explicit choices, package startup arguments, web settings, and the narrow usage fetch adapter.

The real-Podman Codex integration builds the default npm package, verifies its installed version and web tool registration, exercises a real Pi tool call to `pi-web-access`, obtains Codex quota numbers through the compatibility adapter, and completes a streamed conversation. Container networking is disabled and host services are fakes; no paid model/search calls are made. The former graphical Pi quota footer is no longer a default; the separate host GNOME indicator still needs graphical lifecycle verification. Live provider behavior requires real-account verification.

Remaining possibilities:

- Immutable Git commit sources and explicit local build contexts.
- Host-managed integrity/update/rollback manifests for transitive dependencies.
- Optional resource filters for skills/prompts/themes.
- Better reconciliation of manually installed duplicate packages.
- Additional credential-proxied providers and usage endpoints.

References: [Pi packages](https://pi.dev/docs/latest/packages), [Pi extensions](https://pi.dev/docs/latest/extensions), [proxy policy](proxy.md), [Codex host sign-in](codex.md).
