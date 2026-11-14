# Offline dummy backend and simulated Codex quota

This is a standalone, explicitly selected **JSONL RPC backend**, not a real Pi/model process or an OpenAI HTTP endpoint. It exercises `PiRpc`/`PiView` without model tokens and is now the fixed backend of the [optional local web demo](web-control.md). Use `npm run web:demo` after installing the optional web package to test its outward connectors and browser UI; real Pi/container web mode is not implemented.

## Try it now

```sh
npm run demo:dummy
```

The demo starts only the fixed local dummy executable, streams lorem ipsum and a fake no-op tool event, simulates exhausted Codex quota for two seconds, observes waiting/refill and streams a single automatic continuation in the same synthetic session. It uses no Pi installation, provider credentials, Podman or TCP service. There is no real-provider fallback.

To connect a JSONL client directly:

```sh
node bin/pis-dummy.js --auto-resume
# Equivalent npm entry point; --silent is required to keep stdout protocol-only:
npm run --silent dummy-agent -- --auto-resume
```

Without `--auto-resume`, automatic continuation is off. All diagnostic/help output is stderr; stdout is JSONL only. Keep stdin open while waiting for streamed work; EOF and SIGINT/SIGTERM/SIGHUP close the dummy and its private wait socket. No session is persisted.

Type/send one JSON object per LF-terminated record, for example:

```json
{"id":"hello","type":"prompt","message":"Hello"}
{"id":"state","type":"get_state"}
{"id":"quota","type":"prompt","message":"/dummy quota 5"}
```

Do not submit all prompts at once: a started prompt is accepted before its work finishes. Wait for `agent_settled` or fetch current state. `PiControl`/`PiView` additionally reject busy or unknown-state prompt submissions, so refresh state after a `handled` simulator control before sending another prompt. `get_messages`, `clear_queue` and `abort` are also supported. There is no arbitrary RPC forwarding, executable selection, tool execution or host approval API.

## Test messages

| Prompt | Behavior |
| --- | --- |
| Any ordinary text | Streams a fixed dummy lorem ipsum response (or a quota error while synthetic quota is exhausted). |
| `/dummy quota 5` | Exhausts synthetic quota for five seconds and emits a failed Codex-like assistant message with `429 usage_limit_reached`; automatic continuation waits for fresh available usage. Durations: 1–300 seconds. |
| `/dummy quota hold` | Exhausts synthetic quota indefinitely until a refill command. |
| `/dummy refill` | Makes synthetic usage available; an already confirmed pending wait can then continue. |
| `/dummy status` | Emits available/exhausted status without adding conversation history. |
| `/dummy cancel` | Cancels a pending continuation; later refill does not replay it. Use `clear_queue` + `abort` to also stop active streamed work. |
| `/dummy auto off` | Cancels and disables automatic continuation. |
| `/dummy auto on` | Enables future quota episodes, never retries an old one immediately. |
| `/dummy transient` | Emits a quota-like 429 while usage is available: the real host waiter returns `not-quota`, so **no** automatic retry is sent. |
| `/dummy error` | Emits an ordinary non-quota failure, with no automatic continuation. |

Refill/status/auto controls are **simulator controls**, not ordinary conversation turns. In particular refill deliberately does not change the synthetic session leaf or cancel the wait: it represents a provider-side quota change, not new user work. Ordinary new conversation input cancels the old pending wait before starting another turn. Changing available quota does not itself initiate work without a previously confirmed pending episode. Duplicate handling belongs to the existing `PiControl` runtime; bare native JSONL IDs only correlate responses and are not themselves replay protection.

`dummy_status` events and projected frames have fixed simulated states and `simulated: true`. This field is not authenticated runtime identity or real host usage evidence; the future server must label dummy registrations independently. Even a real sandbox could author misleading event/text content. Never use a chat claim, dummy event or extension dialog to authorize real host actions.

## What this actually tests

`src/dummy-agent.js` reuses the production `isCodexQuotaError`, `startCodexAutoServer`, `waitForCodex`, `requestCodexWait` and fixed continuation notice. Exhaustion/availability is supplied entirely by a local synthetic usage function, including explicit `routeUsage`; no Codex auth/usage HTTP request is made. The real private Unix-socket handshake and fresh exhausted-to-available checks are exercised. A 250 ms injected poll sleep and disabled initial-check cooldown are **dummy-only**; production polling/cooldowns are unchanged.

The dummy has its own small same-session/leaf/epoch/idle/abort simulator around that waiter. It does **not** run the real Pi TUI extension or test its complete native lifecycle/retries/compaction. In particular it does not enable production `pis --auto-wait-codex` in RPC, which remains unsupported. Existing extension lifecycle tests are separate. Real subscription exhaustion/refill, real Pi TUI and Podman remain unverified by this simulator.

Automatic recovery appends the fixed continuation notice as one synthetic user turn; it never replays the original prompt or any tool. The lorem output and fake `dummy_noop` lifecycle events cannot execute filesystem/shell/Git/package operations. Provider/model labels are synthetic even though quota errors use `openai-codex` to exercise the shared detector.

## Bounds and verification

The process holds at most 100 messages/512 KiB of serialized final history in memory and drops oldest messages; snapshot indices are local to retained history, not durable IDs. Text prompts are limited to 64 KiB, native input records to 128 KiB, concurrent command handlers to 16 and buffered stdout to 2 MiB. Some heavily JSON-escaped prompts can hit the record/write cap before the text cap. Unknown command fields are rejected. Session identity/history, quota and pending continuations disappear on exit; there is no persisted queue or server transcript store.

`node --test test/dummy-agent.test.js` runs eight offline subprocess tests covering lorem/tool streaming, timed/manual refill, multiple quota cycles, same-session single continuation, stop/disable cancellation, transient/non-quota errors and aborting output. A test preload rejects TCP/fetch; only the private quota Unix socket is permitted. This is a regression guard for trusted code, not an OS sandbox. `npm run check` includes the tests and syntax checks. The interactive demo was also run successfully without any model requests.
