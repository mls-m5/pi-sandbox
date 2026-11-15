# Codex Usage GNOME Shell extension

A small GNOME Shell panel extension that displays the **remaining** Codex subscription quota. It deliberately does not read OAuth files itself: it invokes the host-side `pis --codex-usage` command, which refreshes credentials and returns only sanitized numeric quota windows.

## Requirements

- GNOME Shell 45–48 (the versions currently listed in metadata)
- `pis` installed at `~/.local/bin/pis` (GNOME Shell does not necessarily inherit your terminal `PATH`)
- A Codex sign-in: `pis --login-codex`

## Install for testing

Run on the **host as your normal user**, not with sudo or inside the sandbox:

```sh
./gnome-codex-usage/install.sh
gnome-extensions enable codex-usage@pis  # if not already enabled
```

The executable Bash installer copies all four runtime files, including `usage-display.js`, into `${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/codex-usage@pis/`. It works from any current directory when invoked by its path, preserves unrelated files and can be rerun for updates. It does not enable extensions, change global GNOME settings, restart the shell or log you out automatically. Source checkout edits alone do not update the installed copy.

**Reloading without closing applications:** on Xorg, press Alt+F2, type `r` and press Enter to restart just GNOME Shell. On Wayland, Shell is also the display compositor and this restart is not supported; logout/login reliably loads changed JavaScript but closes session applications, so save work first. Disabling/enabling only `codex-usage@pis` can recreate the indicator without closing apps, but JavaScript modules may remain cached: it is not a guaranteed code-update reload. Refresh only fetches quota; it does not reload installed code. Do not kill/replace Shell as a Wayland workaround. The extension refreshes every five minutes and also has a manual Refresh menu action.

The panel shows remaining percentage and a reset countdown, for example `Codex Short 98% (3h 25m) / Week 72% (3d 6h)`. The menu labels the primary/secondary slots and their window types individually. Reported `limit_window_seconds` determines short/weekly labels when present; without it the historical primary-short/secondary-weekly convention is used. Reset countdown length alone does not determine the window type.

The indicator reports **only the currently selected host account**, not both accounts in an automatic pool. After switching, use Refresh or wait for the next five-minute poll. Some account responses may omit a quota window: that slot now stays visible as `Primary —` or `Secondary —`, with a menu explanation that it was not reported (not an invented 0%/100%). A weekly window returned in the primary slot is labelled Week when its reported duration identifies it. Old percentages are never carried over from another account to fill a missing window. To diagnose a missing value, run host `pis --codex-usage`; it prints sanitized quota windows, not credentials. Do not share auth files or raw upstream responses. This display fix is covered by offline snapshot-switch/duration tests; actual account responses/GNOME rendering still require host verification. Short-window reset times use hours/minutes; weekly reset times use days/hours, rounded up to the displayed unit. The short window is not necessarily a day (often five hours), so it is not labelled as a daily limit.

Countdowns update locally every minute while upstream usage is fetched every five minutes. Absolute `reset_at` is preferred; `reset_after_seconds` is anchored to when data was fetched, not each redraw. Expired windows display `now`; quota percentages are not invented/reset locally. Missing reset times display `unknown`. If authentication or the network fails, the panel shows `Codex —`; the menu shows an error status. No real credential is returned by the usage command.

Install/run this on the host, not inside the sandbox. If GNOME has user extensions globally disabled, enable them in the Extensions app (or deliberately set `org.gnome.shell disable-user-extensions` to false). A newly copied extension may need a logout/login to be discovered, especially on Wayland. Repository edits do not automatically update the installed copy: rerun `install.sh` and reload as described above.

`~/.local/bin/pis` must also select a compatible Node >=22.19. A symlink to `bin/pis.js` uses `/usr/bin/env node` and can pick up an old Node in GNOME's PATH. On the development host this was solved with a launcher explicitly using Pi's bundled Node; see [host-local operational pitfalls](../docs/development.md#host-local-operational-pitfalls). The extension deliberately calls the absolute launcher path because setting `~/.config/environment.d` did not update GNOME's PATH in the tested session.
