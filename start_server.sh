#!/usr/bin/env bash
# Local dummy web demo by default; --project explicitly selects real Pi.
# Does not change the system Node or normal pis configuration.
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  printf '%s\n' \
    'Usage: ./start_server.sh [--project NAME (repeatable) | --agents 1..8] [--port PORT] [--password-stdin]' \
    'Default: dummy-only demo, no model calls. --project starts real registered Pi sandboxes; prompts may cost tokens.' \
    'Web server runs on the host, NOT in a sandbox; real Pi agents remain in Podman. Loopback only.' \
    'Uses Node >=22.19 on PATH, then a compatible bundled Node, otherwise npm-provided Node 24.' \
    'The npm fallback may download Node. It does not change your default Node.'
  exit 0
fi

if [[ ! -f "$ROOT/web/node_modules/ws/package.json" ]]; then
  printf '%s\n' 'Install the optional web dependency first (from this checkout):' \
    '  npm --prefix web ci --ignore-scripts --omit=optional --no-audit --no-fund' >&2
  exit 1
fi

compatible_node() {
  "$1" -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 19) ? 0 : 1)' >/dev/null 2>&1
}

cd -- "$ROOT"
if command -v node >/dev/null 2>&1 && compatible_node node; then
  exec node "$ROOT/web/cli.js" start "$@"
fi
BUNDLED="${HOME:-}/.local/share/pi-node/current/bin/node"
if [[ -x "$BUNDLED" ]] && compatible_node "$BUNDLED"; then
  exec "$BUNDLED" "$ROOT/web/cli.js" start "$@"
fi
if ! command -v npm >/dev/null 2>&1; then
  printf '%s\n' 'Node >=22.19 or a working npm (for the Node 24 fallback) is required.' >&2
  exit 1
fi
printf '%s\n' 'Using npm-provided Node 24 (may download on first use; system Node unchanged).' >&2
exec npm exec --yes --package=node@24 -- node "$ROOT/web/cli.js" start "$@"
