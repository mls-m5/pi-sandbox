#!/usr/bin/env bash
# Install this extension for the current host user only. Never restart Shell or
# toggle global extension settings automatically: Wayland logout closes apps.
set -euo pipefail

SOURCE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
if [[ $# -gt 0 ]]; then
  if [[ $# -eq 1 && ( "$1" == '--help' || "$1" == '-h' ) ]]; then
    printf '%s\n' 'Usage: ./gnome-codex-usage/install.sh' \
      'Copies the extension into your user GNOME data directory.' \
      'Does not enable/restart GNOME Shell or log you out. Run on the host, without sudo.'
    exit 0
  fi
  printf '%s\n' 'Unknown arguments. Use --help.' >&2
  exit 2
fi
if [[ ${EUID} -eq 0 ]]; then
  printf '%s\n' 'Run this installer as your normal host user, not root/sudo.' >&2
  exit 1
fi
DATA="${XDG_DATA_HOME:-${HOME:?HOME must be set}/.local/share}"
if [[ "$DATA" != /* ]]; then
  printf '%s\n' 'XDG_DATA_HOME must be an absolute path.' >&2
  exit 1
fi
TARGET="$DATA/gnome-shell/extensions/codex-usage@pis"
FILES=(metadata.json extension.js usage-format.js usage-display.js)
for file in "${FILES[@]}"; do
  if [[ ! -f "$SOURCE/$file" ]]; then
    printf 'Missing source file: %s\n' "$file" >&2
    exit 1
  fi
done
mkdir -p -- "$TARGET"
# Do not delete unrelated files, user settings or other extensions.
for file in "${FILES[@]}"; do
  if [[ -L "$TARGET/$file" ]]; then
    printf 'Refusing to overwrite a symbolic link: %s\n' "$TARGET/$file" >&2
    exit 1
  fi
done
for file in "${FILES[@]}"; do
  install -m 644 -- "$SOURCE/$file" "$TARGET/$file"
done
printf 'Installed Codex Usage in: %s\n' "$TARGET"
printf '%s\n' \
  'To enable it (if necessary), run on the host:' \
  '  gnome-extensions enable codex-usage@pis' \
  'Xorg: Alt+F2, type r, press Enter to reload Shell without closing apps.' \
  'Wayland: reliable loading of changed JavaScript requires logout/login (save work first).' \
  'Disabling/enabling only this extension may reuse cached code; it is not a guaranteed update reload.' \
  'No Shell restart, logout or extension toggle was performed.'
if [[ ! -x "${HOME}/.local/bin/pis" ]]; then
  printf '%s\n' 'Note: ~/.local/bin/pis is missing or not executable; the extension needs that host launcher (Node >=22.19).' >&2
fi
