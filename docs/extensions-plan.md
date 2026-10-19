# Image extensions and configuration completion

**Implemented:** project JSON install sources, image-baked npm packages, automatic loading, a source inventory command, JSON defaults/hints, and a generated editor schema. Git/local build sources and advanced package lock/update management remain future work.

## Install by source, not by path

Pi normally installs packages with:

```sh
pi install npm:pi-web-access@0.40.0
```

Put that same install specification in the project's JSON instead:

```json
{
  "extensions": [
    "npm:pi-usage-bar-focus@0.5.0",
    "npm:pi-web-access@0.40.0"
  ]
}
```

This is a fragment: retain the rest of `project.json`. Run `pis --edit`, save, and start `pis` or run `pis --build`. An extension source change changes the image fingerprint automatically. The next launch cannot silently reuse an image with different configured sources.

The build runs Pi's own installer inside Podman with `PI_CODING_AGENT_DIR=/opt/pis/agent`. npm lifecycle scripts are disabled. No source package installation, extension factory, or npm script is executed by the host wrapper. Runtime provider credentials and host Pi configuration are not supplied to the build.

Installed resources remain in the image under `/opt/pis`. An image-owned bootstrap supplies their local package roots to Pi's extension loader, so package manifests and Pi's API aliases work normally without runtime installation. Only extensions are activated through these arguments, not a package's skills/prompts/themes. The `pi` command inside `pis --bash` uses the same bootstrap.

Packages are executable trusted code. They run with Pi's container permissions, not as host plugins. Package source/version pinning is not an approval or security boundary against malicious package code.

## Defaults and inventory

The default image sources are:

| Source | Purpose |
| --- | --- |
| `npm:pi-usage-bar-focus@0.5.0` | Model-aware Codex/ChatGPT and other provider quota/status footer |
| `npm:pi-web-access@0.40.0` | Web search, source checking, content fetching, and stored-result retrieval |

Host inventory observed while implementing this feature also included `npm:@beyona/pi-zai-usage@1.1.0`. It overlaps with the usage bar, so it is an inert example rather than another enabled default. Host settings are not scanned or imported automatically on startup.

```sh
pis --extensions-list       # Configured image sources; does not build
pis -- list                # Image sources, then additional sandbox-state packages
pis --show                 # Full effective project configuration
```

Use `"extensions": []` to opt out. Missing fields receive the two defaults; explicit existing arrays are never appended to. Removing one entry keeps it removed, including on later configuration loads. Changing the program's defaults does not upgrade explicitly stored package versions.

## Supported specifications

- `npm:package-name`
- `npm:package-name@1.2.3`
- `npm:@scope/package-name@1.2.3`
- `npm:package-name@canary`

Exact versions are recommended. Unversioned packages and tags resolve during image creation, not each launch; use `pis --rebuild` to refresh them. npm's lockfile remains in the image, but clean builds do not yet have a host-managed transitive dependency lock.

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

The same completion runs after `pis --edit`, before validation/save. Invalid edits retain the previous valid file. New fields in a selected proxy mode appear automatically: API-key mode gets missing `keyEnv`; Codex gets model/request-limit defaults but never an API-key-only field. If `credentials.proxy` was deliberately absent, it stays absent; alternative modes are examples, not silently activated permissions.

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

The real-Podman Codex integration builds both default npm packages, verifies their installed versions and web tool registration, exercises a real Pi tool call to `pi-web-access`, obtains Codex quota numbers through the compatibility adapter, and completes a streamed conversation. Container networking is disabled and host services are fakes; no paid model/search calls are made. Live provider behavior and the graphical quota footer still need real-account/terminal verification.

Remaining possibilities:

- Immutable Git commit sources and explicit local build contexts.
- Host-managed integrity/update/rollback manifests for transitive dependencies.
- Optional resource filters for skills/prompts/themes.
- Better reconciliation of manually installed duplicate packages.
- Additional credential-proxied providers and usage endpoints.

References: [Pi packages](https://pi.dev/docs/latest/packages), [Pi extensions](https://pi.dev/docs/latest/extensions), [proxy policy](proxy.md), [Codex host sign-in](codex.md).
