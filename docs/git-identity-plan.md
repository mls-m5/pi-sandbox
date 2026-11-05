# Planned: Git identity in the sandbox

Requested: inherit the host user's global Git `user.name` and `user.email` so commits made inside the sandbox have the expected author identity.

Not implemented yet. This is separate from host-side git push approval.

Suggested approach:

- Read only `user.name` and `user.email` from the host's global Git configuration using argument arrays, never a shell.
- Initialize missing identity fields in the sandbox Git configuration on launch, or expose explicit project identity settings with these defaults.
- Preserve explicit sandbox/project identity choices; decide and document how later host identity changes should propagate.
- Handle missing global values without failing startup.
- Never mount or copy the host's full `.gitconfig`: it may contain credentials, includes, signing configuration, credential helpers or executable commands.
- Do not forward tokens, credential helpers, hooks, SSH configuration or signing keys.
- Test missing identity, spaces/non-ASCII values, and precedence between host defaults and explicit sandbox/project settings.
