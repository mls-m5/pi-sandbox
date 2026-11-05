# Wait for Codex quota, then resume Pi

From a registered project, after exiting the paused/limited Pi session:

```sh
pis --wait-codex
# Or select a registered project explicitly:
pis --project my-app --wait-codex
```

`--wait-codex` is an **opt-in startup gate**. For automatic detection while Pi is running, opt into `--auto-wait-codex` instead (or combine the flags). Ordinary `pis` startup is unchanged.

## Automatic wait during a run

```sh
pis --auto-wait-codex
# Or start a new long-running task:
pis --fresh --auto-wait-codex -- "Continue implementing and testing the agreed plan"
# Check quota at startup AND monitor the saved task afterward:
pis --wait-codex --auto-wait-codex
```

Automatic mode requires a **terminal Pi session**, saved sessions and extensions enabled, and the Codex host proxy. An initial prompt, `--fresh` and explicit Pi session selectors are supported. Claude, shell/exec, Pi management commands, print/JSON/RPC, `--no-session`, `--no-extensions` and custom stdio are rejected. The flag is CLI-only and does not alter project defaults. Starting the updated wrapper may rebuild the image to install its image-owned extension.

### Detection and continuation

- The image-owned extension observes failed **main Codex assistant messages** with quota-like errors (HTTP 429, usage-limit markers, etc.). It also handles a quota-like failure during native context-overflow recovery. It does not treat successful assistant claims, user aborts, tool output, manual/idle compaction failures or another provider's errors as quota stops.
- It waits until Pi emits `agent_settled`, after native retries, recovery and queued work have finished. No lifecycle handler is held waiting for hours. The host checks the same usage endpoint as `--codex-usage`: the error text alone is **not trusted proof** of exhaustion.
- If usage is already available, the host returns `not-quota` and **no automatic retry** is sent. A transient 429, exhausted local proxy request budget or unrelated network error must not become an unconditional retry loop. Unknown/malformed usage or auth/network errors stop the automatic wait safely with a UI warning, rather than guessing or prompting for credentials.
- Once the host confirms exhaustion, it polls at the same 1–5 minute intervals as the startup gate. A fresh response must indicate that every returned short/weekly window is below 100%, with no denial flag. A passed countdown is not sufficient.
- **Pi and its container remain running**, idle, with the existing session file, active branch, selected model and tool state. The extension verifies that those identities are unchanged and Pi has no pending work before sending **one fixed English user continuation prompt**. The prompt asks the agent to inspect current state before repeating tools and not restart completed work. It triggers a model turn and **uses quota/tokens**. No initial task is replayed, no process is restarted, no tool is killed and no new provider is selected. This is model-driven continuation, not transactional exactly-once execution: the agent must still inspect prior tool effects before acting.
- This can repeat across later confirmed exhaustion/refill cycles in the same running session. It is not an infinite immediate-error retry: each continuation requires a fresh exhausted-to-available host observation. Availability is not a reservation; other clients or model-specific limits can still reject the next request. Limits not represented in the returned main usage windows cannot safely be inferred from error text.

The project lock, container and proxy stay active during automatic waiting. Native idle cache warming is suppressed while automatic mode is enabled, to avoid spending quota in the background. This feature itself makes only usage/auth requests while waiting; it does not freeze unrelated background processes or arbitrary other extensions.

### Cancel and keep control

Press **Escape or Ctrl-C**, submit new input, start another run, change session/branch/model/thinking level, compact or run a user Bash command to cancel a pending continuation. A final session-file/leaf/model/idle check also blocks a stale response from continuing the wrong conversation. Queued work takes priority.

Inside Pi:

```text
/codex-auto off
/codex-auto on
/codex-auto status
```

`off` cancels and disables automation in the **current extension runtime**. `on` arms it for future failures; it does not replay an old task immediately. When the extension runtime is recreated (for example on reload, session replacement or an apt/Git-approved Pi restart), it uses the original CLI opt-in flag, so use a launch without the flag to disable it for future runs. Exit Pi or stop the wrapper to end waiting permanently; there is no durable background resume queue.

For overnight work keep the host awake and the terminal alive, e.g. in a user-managed `tmux` session. This is not a detached job scheduler and does not bypass normal tool permissions, project trust, apt/Git host approval or authentication failures. Tasks requiring human approval still stop for it.

### Host/container boundary

The extension receives a read-only mount of a dedicated private Unix-socket directory at `/pis/codex-auto`, not OAuth files. The host service accepts only `{ "type": "codex-wait" }` and returns fixed states (`waiting`, `ready`, `not-quota`, `busy`, `error`). Session paths, error text, arbitrary prompts, commands, URLs and approval fields are not accepted. This service cannot approve apt or Git actions.

The host independently confirms exhaustion before a `ready` response is possible. Only one wait is active at a time; new initial checks are throttled to at most one per minute. Disconnect/cancellation aborts the host request/sleep, and container cleanup closes the service. The extension cancels on shutdown/reload and rejects unexpected or unconfirmed protocol responses. No real credential crosses this interface.

## Startup gate behavior

1. Requires the Pi agent, `credentials.proxy.provider: "openai-codex"`, and an existing saved Pi session. `--agent pi --wait-codex` can override a project's Claude default. Saved-session directory checks do not read transcript contents and reject symlinked directories.
2. Holds the project's exclusive lock while waiting, so another pis build/session/login for this project cannot race the continuation. No container, Pi process, image build or proxy socket is started until quota is available. The host remains running; this is not a detached scheduler. Configuration is re-read before startup; if it changed while waiting, the command stops rather than launching stale settings.
3. Calls the same fixed host usage endpoint as `pis --codex-usage`. OAuth credentials remain on the host and can refresh there. Waiting makes usage/auth requests, **not model requests**.
4. Requires every returned short/weekly quota window to be below 100% used. Optional upstream `allowed: false` or `limit_reached: true` also block startup. At least one valid quota window is required; unknown/malformed usage never authorizes startup.
5. Checks again at intervals of **one to five minutes**. Reported reset times help choose the next check, with a small grace period, but reaching a countdown of zero never grants permission by itself. A fresh usage response must report available quota. If both windows are exhausted, both must clear.
6. Starts Pi with `--continue` and one fixed English user message asking it to continue the previous task, review current state before repeating tools, and not restart completed work. This message triggers a model turn and **uses subscription quota/tokens**. The original prompt and one-off command options are not replayed.

The continuation follows Pi's normal latest-session selection; it does not capture a specific session ID or branch. Start from the intended working directory/project and ensure the saved session uses Codex. Existing session/model selection is preserved; pis does not select another provider or fall back to paid API-key access. Usage availability is not a reservation or a guarantee that the saved model's next request will succeed: model-specific limits, capacity and other clients consuming quota can still interfere.

The wait flag is consumed before starting Pi. It is not repeated after an approved apt/Git restart. There is no post-exit retry loop: another quota error during the resumed conversation needs a new explicit `pis --wait-codex` invocation unless `--auto-wait-codex` was also enabled.

## Cancellation and errors

Ctrl-C cancels without starting Pi. SIGTERM and SIGHUP also cancel; signal handlers are removed before agent startup, and the project lock is released. Closing the host process, rebooting or a failed start does not leave a persistent resume queue.

An authentication, network or usage-parsing error stops the wait without starting the agent. Inspect `pis --codex-usage` on the host, sign in again if required, then retry. pis does not retry a failed login forever, treat unknown quota as available, or print credential/upstream response bodies.

`--wait-codex` cannot be combined with management commands, Claude, `--fresh`, `--bash`, `--exec`, trailing Pi arguments or custom stdio. This prevents accidentally replaying an initial task or injecting a continuation into print/JSON/RPC output. It has no effect on normal launches unless explicitly supplied.

## Verification

Fast offline tests cover both windows, denial flags, expired reset times, poll timing, cancellation during fetch/sleep, private-data filtering, missing/unsafe sessions, option conflicts, project locking, edits during waiting and the exact continuation arguments. The launch test uses fake Podman commands and fake OAuth credentials and makes no model calls. Automatic-mode tests additionally cover real local Unix sockets with fake quota data, host confirmation/cooldown/cancellation, image/socket wiring, mocked Pi lifecycle events, interrupted overflow recovery, same-session continuation, stale/cancelled responses, repeated quota episodes and malformed protocol replies. These are not a full real-Pi TUI lifecycle test. Full interactive quota exhaustion/refill/resume with a real subscription and real Podman remains unverified here; no live model requests were made.
