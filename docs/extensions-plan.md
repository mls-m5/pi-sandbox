# Extension support plan

**Status:** Pi's existing extension/package features work inside the sandbox today. Declarative extension management through `project.json` is planned, not implemented. Do not add the proposed `extensions` field to current configurations yet; unknown fields are rejected.

## Principles

1. Extensions run inside container Pi, never in the host wrapper or credential proxy.
2. Extension selection is project-scoped. Do not mount host `~/.pi/agent` or automatically import its extensions/settings.
3. Code is executable and must be trusted. Container isolation limits host access; extension approvals do not make code safe.
4. Selecting an extension must not implicitly grant new mounts, real credentials, host processes, or container privileges.
5. Prefer Pi's loader/package manager rather than implementing a competing TypeScript loader or plugin API.
6. Do not execute extension code, npm lifecycle scripts, or credential commands on the host during validation.

## What works now

### Local extension in the project

From the project root, create `tools/hello.ts`:

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("hello", {
    description: "Show a greeting",
    handler: async (_args, ctx) => {
      if (ctx.hasUI) ctx.ui.notify("Hello from the sandbox", "info");
    }
  });
}
```

Then load it explicitly:

```sh
pis -- -e ./tools/hello.ts
```

The file is already inside the project mount. Pi uses its TypeScript loader; the host needs no TypeScript compiler or extension dependencies. Imports needing additional npm dependencies must be installed inside the sandbox or supplied by an explicit image customization.

Pi resolves relative `-e` paths against the invocation working directory. When invoking from a subdirectory, use the correct relative path or the extension's absolute project path.

For an extension outside the project, first share its containing directory explicitly in `mounts`, preferably read-only, then use its identical absolute container path with `-e`. Do not share your entire home to expose one extension.

### Pi packages

Use Pi's package commands through the wrapper:

```sh
# Replace this example source with an actual, trusted package and exact version.
pis -- install npm:@example/pi-tools@1.2.3
pis -- list
pis -- config
pis -- remove npm:@example/pi-tools
```

These commands run inside the container and skip implicit `--continue`. Personal Pi settings and managed package data are stored in this project's persistent sandbox home, not the host's Pi installation. Network access is needed for installation, and package code/installers remain untrusted executable code inside the boundary.

Pi also supports one-shot sources such as `pis -- -e npm:@example/pi-tools@1.2.3`. An explicitly supplied `-e` loads even with Pi's `--no-extensions`; that option disables discovered/configured extensions, not explicit command-line ones.

In proxy mode, the host key must be available for launching this environment, even when invoking a package command. Extensions and installers see only the dummy OpenAI key. They can still spend through the permitted proxy endpoints, access shared files, and use the allowed network.

## Proposed declarative configuration

Future optional field in `project.json`:

```json
{
  "extensions": {
    "local": [
      { "path": "./tools/hello.ts", "enabled": true },
      { "path": "/home/mattias/Prog/pi-tools/index.ts", "enabled": false }
    ],
    "packages": [
      { "source": "npm:@example/pi-tools@1.2.3", "enabled": true }
    ]
  }
}
```

This is a proposal, not an accepted current configuration fragment. Generate inert examples for the field when implementing it, just as with mount examples.

### Local path policy

- Resolve relative paths from the **registered project root**, regardless of invocation subdirectory.
- Accept supported `.ts`/`.js` files or package directories with supported entry points.
- Resolve symlinks and require the selected resource to be inside the registered root or an already declared additional mount.
- Reject paths outside exposed directories; explain the required explicit mount instead of creating it automatically.
- Do not require write access to an extension's source. Editing code in read-only shared directories is not allowed; runtime data belongs in sandbox state.
- Do not put extension source into the image/build context by default. Local edits should be visible on next start or Pi `/reload`.
- Local package dependencies are the user's responsibility initially; do not run host npm to install them.

### Package policy

- Start with exact versioned npm sources; add immutable Git commit sources after npm support is stable.
- Reject unversioned sources, `latest`, version ranges, mutable branches/tags, and shell fragments for wrapper-managed declarations.
- Install only through sandboxed Pi/package-manager commands. Never import packages into the host CLI.
- Require an explicit synchronization step, rather than installing or updating packages silently during normal startup.
- Default wrapper-managed package resource filters to extensions only; skills, prompts, and themes require a separate explicit choice. Pi packages can contain all of these resources.
- Record requested sources, resolved versions/commits, integrity metadata, and selected filters in a host-managed lock manifest outside the workspace/state mount.
- Keep that lock manifest declarative: a pinned source is not proof that executable code is safe or that a writable installed copy cannot be modified inside the sandbox.
- Private package registry credentials need a separate, narrowly scoped design. Do not reuse or expose the real OpenAI key for package installation.

## Proposed commands and lifecycle

```sh
pis --extensions-list       # Declared and manually installed resources, with provenance
pis --extensions-sync       # Explicit install/reconcile of declared pinned packages
pis --without-extensions   # Diagnostic run without discovered or wrapper-managed extensions
```

These commands are not implemented yet.

Normal startup would:

1. Validate configuration and already-exposed local paths without executing code.
2. Check the package synchronization manifest; fail with synchronization guidance if declarations changed or installations are missing.
3. Start the same sandbox/proxy as usual.
4. Inject enabled local extension paths using Pi's explicit `--extension` arguments.
5. Load synchronized packages through Pi settings and its loader.

`--without-extensions` should suppress wrapper-injected extension arguments and pass Pi's `--no-extensions` to disable discovery/configured packages. An explicit user `-e` after `--` remains an intentional override. Do not present this diagnostic flag as a security boundary: Pi itself and generated commands retain their ordinary sandbox permissions.

Synchronization should preserve unrelated user Pi settings and manual package installations. It must not replace the entire `settings.json` with a generated file. Define a managed ownership manifest so removal affects only resources the wrapper installed. Use per-project locks during installation and update the host lock manifest atomically only after success.

Normal runs should not fetch package updates. Changing local paths or enabling/disabling extensions should not rebuild the image. Package install state lives in project state initially; immutable image-baked extension bundles can be a later reproducibility feature.

## Credential and trust interactions

- Wrapper-managed declarations live in host project configuration, not repository-controlled settings.
- Pi's existing project trust decision still applies to repository `.pi` resources. Do not pass `--approve` automatically.
- Explicit wrapper-managed local paths are user-approved executable code, analogous to explicit `-e` arguments. Document that they bypass discovery-based trust gating.
- Extensions can inspect prompts, files, conversations, and the dummy capability. They must not receive the real OpenAI key, even if an extension registers its own provider or calls APIs directly.
- The proxy's upstream, endpoint/model policy, and request budget stay on the host, independent of extension code. An extension can use the capability but cannot change that host policy.
- A custom provider extension using a different protocol/upstream requires separate credential/routing support; never silently forward host keys as a fallback.

## Implementation stages

1. **Local declarations:** schema/default examples, canonical path validation, enabled selection, explicit Pi arguments, and diagnostic disable flag.
2. **Pinned npm declarations:** explicit sandboxed sync, managed Pi settings entries/resource filters, host lock manifest, inventory, and safe removal.
3. **Reproducibility:** immutable Git references, integrity verification, version migration, optional image-baked dependencies, and clearer update/rollback UX.

## Acceptance tests

- Local extension loads in interactive and print modes and survives ordinary project session continuation.
- Startup from a subdirectory resolves declarations relative to project root.
- Disabled entries are never imported; the diagnostic flag disables wrapper and discovery loading.
- External source paths fail unless already explicitly shared; symlink escape does not create hidden mounts.
- Two projects cannot inherit each other's package settings or managed state.
- Package installation executes no extension or lifecycle code on the host.
- Missing packages do not trigger silent network installs on normal startup.
- Failed synchronization preserves previous working settings and lock metadata.
- Extension code sees only the proxy dummy credential; the host fake upstream sees the injected real test key.
- An extension cannot redirect the host proxy upstream or bypass its route/model limits through request headers.
- Existing manual Pi settings/packages are preserved when managed packages are added or removed.

The real-Podman proxy test already loads an explicit local TypeScript extension and verifies its UID and dummy-key view. Declarative configuration and package lifecycle tests will be added as the stages above are implemented.

## Pi references

- [Extensions](https://pi.dev/docs/latest/extensions)
- [Pi packages](https://pi.dev/docs/latest/packages)
- [Custom providers](https://pi.dev/docs/latest/custom-provider)
