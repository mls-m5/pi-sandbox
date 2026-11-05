# Codex Usage GNOME Shell extension

A small GNOME Shell panel extension that displays the **remaining** Codex subscription quota. It deliberately does not read OAuth files itself: it invokes the host-side `pis --codex-usage` command, which refreshes credentials and returns only sanitized numeric quota windows.

## Requirements

- GNOME Shell 45–48 (the versions currently listed in metadata)
- `pis` installed at `~/.local/bin/pis` (GNOME Shell does not necessarily inherit your terminal `PATH`)
- A Codex sign-in: `pis --login-codex`

## Install for testing

From this repository:

```sh
mkdir -p ~/.local/share/gnome-shell/extensions/codex-usage@pis
cp gnome-codex-usage/metadata.json gnome-codex-usage/extension.js \
  gnome-codex-usage/usage-format.js \
  ~/.local/share/gnome-shell/extensions/codex-usage@pis/
gnome-extensions enable codex-usage@pis
```

Log out and back in, or restart GNOME Shell where supported. The extension refreshes every five minutes and also has a manual Refresh menu action.

The panel shows remaining percentage and a reset countdown, for example `Codex 98% (3h 25m) / 72% (3d 6h)`. The menu labels the short and weekly windows individually. Short-window reset times use hours/minutes; weekly reset times use days/hours, rounded up to the displayed unit. The short window is not necessarily a day (often five hours), so it is not labelled as a daily limit.

Countdowns update locally every minute while upstream usage is fetched every five minutes. Absolute `reset_at` is preferred; `reset_after_seconds` is anchored to when data was fetched, not each redraw. Expired windows display `now`; quota percentages are not invented/reset locally. Missing reset times display `unknown`. If authentication or the network fails, the panel shows `Codex —`; the menu shows an error status. No real credential is returned by the usage command.

Install/run this on the host, not inside the sandbox. If GNOME has user extensions globally disabled, enable them in the Extensions app (or deliberately set `org.gnome.shell disable-user-extensions` to false). A newly copied extension may need a logout/login to be discovered, especially on Wayland. Repository edits do not automatically update the installed copy: repeat the copy step and reload the session.

`~/.local/bin/pis` must also select a compatible Node >=22.19. A symlink to `bin/pis.js` uses `/usr/bin/env node` and can pick up an old Node in GNOME's PATH. On the development host this was solved with a launcher explicitly using Pi's bundled Node; see [host-local handover notes](../docs/handover.md#host-local-changes-not-portable-repository-configuration). The extension deliberately calls the absolute launcher path because setting `~/.config/environment.d` did not update GNOME's PATH in the tested session.
