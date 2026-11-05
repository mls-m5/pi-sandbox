# Codex Usage GNOME Shell extension

A small GNOME Shell panel extension that displays the **remaining** Codex subscription quota. It deliberately does not read OAuth files itself: it invokes the host-side `pis --codex-usage` command, which refreshes credentials and returns only sanitized numeric quota windows.

## Requirements

- GNOME Shell 45 or newer
- `pis` installed at `~/.local/bin/pis` (GNOME Shell does not necessarily inherit your terminal `PATH`)
- A Codex sign-in: `pis --login-codex`

## Install for testing

From this repository:

```sh
mkdir -p ~/.local/share/gnome-shell/extensions/codex-usage@pis
cp metadata.json extension.js ~/.local/share/gnome-shell/extensions/codex-usage@pis/
gnome-extensions enable codex-usage@pis
```

Log out and back in, or restart GNOME Shell where supported. The extension refreshes every five minutes and also has a manual Refresh menu action.

The panel shows remaining percentage, while the menu shows one value for each returned rate-limit window. If authentication or the network fails, it shows `Codex —` rather than exposing an error or credential.
