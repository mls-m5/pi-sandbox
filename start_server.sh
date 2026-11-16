#!/usr/bin/env bash
# Local dummy web demo by default; --project explicitly selects real Pi.
# Does not change the system Node or normal pis configuration.
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ENTRY="$ROOT/web/supervisor.js"
MODE=(start)
if [[ "${1:-}" == "--connect" ]]; then
  shift
  ENTRY="$ROOT/web/agent-cli.js"
  MODE=()
  if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
    printf '%s\n' \
      'Usage: pis --connect [NAME] [--server ADDRESS] [--project PROJECT | --dummy] [--diagnostics]' \
      '       pis --connect --set-server ssh://[USER@]HOST[:SSH_PORT][/PIS_PORT]' \
      '       pis --connect --set-server http://127.0.0.1:43128' \
      '       pis --connect register NAME --server http://127.0.0.1:43128 (--project PROJECT | --dummy) [--replace] [--key-stdin]' \
      '       pis --connect run NAME [--diagnostics]' \
      '       pis --connect forget NAME' \
      '--allow-web-git explicitly trusts server admins to approve exact non-force pushes on this Pi host after sandbox shutdown; not saved. No apt/recursive push/automatic resume.' \
      'Default connect: enter the client-displayed two-digit code under Väntande klienter in the authenticated server UI.' \
      'Bare connect uses the current registered Pi project and saved global server; if absent, it asks and saves the address (TTY only).' \
      '--server overrides the address for one invocation without saving. --set-server saves only; it starts no SSH/runtime.' \
      'SSH defaults: port 22, remote pis port 43128. USER defaults to your client host login name.' \
      'Examples: pis --connect --set-server ssh://192.0.2.10' \
      '          pis --connect --set-server ssh://alice@server.example' \
      '          pis --connect --server ssh://alice@server.example:2222/43129' \
      'Run pis --server --standalone on the SSH host (127.0.0.1:PIS_PORT). Each client owns one ssh -N -L until exit.' \
      'Forwarding uses a private Unix socket, avoiding local TCP-port clashes without relaxing Host/Origin checks.' \
      'Requires OpenSSH on the client host, key login, and an independently verified known_hosts entry.' \
      'Test ssh -p SSH_PORT USER@HOST first. Tunnels require BatchMode=yes and StrictHostKeyChecking=yes.' \
      'No password prompts or automatic host-key acceptance; host ~/.ssh/config aliases/ProxyCommand are not loaded.' \
      'Default host key files/SSH agent remain usable; no SSH credentials or agent sockets are mounted in Pi containers.' \
      'A public HTTPS/CDN domain is usable only if SSH is also separately reachable there.' \
      'NAME selects registered ID/name or unique final folder component unless --project is supplied. Existing work is never killed.' \
      'Advanced GUI keys use --enrollment-key (hidden input) or --key-stdin. The default no longer asks for a GUI key.' \
      'Legacy register/run commands remain available for direct agent keys. Never put keys in command arguments.' \
      'Host-private profiles under PIS_HOME/web-agents; keys never mounted into the sandbox. Direct HTTP remains loopback-only.' \
      'Standalone restart retains registrations with the same storage/port. Ctrl-C stops the local agent, not the server.'
    exit 0
  fi
fi

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  printf '%s\n' \
    'Usage: ./start_server.sh [--standalone | --project NAME (repeatable) | --agents 1..8] [--port PORT] [--password-stdin] [--diagnostics]' \
    '--standalone starts only the server; agent registrations persist privately per port. Use pis --connect --help.' \
    '--allow-web-git with --project explicitly enables stopped-sandbox exact-commit Git push approval; no force, apt or automatic resume.' \
    'Default: dummy-only demo, no model calls. --project starts real registered Pi sandboxes; prompts may cost tokens.' \
    '--diagnostics emits bounded safe request metadata; share only pis web diagnostic: lines, never passwords/state folders.' \
    'Empty password input generates a strong password shown once on stderr (visible in terminal/log captures).' \
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

# Bare connect resolves the caller's project, not the pis checkout.
if [[ "$ENTRY" != "$ROOT/web/agent-cli.js" ]]; then
  cd -- "$ROOT"
fi
if command -v node >/dev/null 2>&1 && compatible_node node; then
  exec node "$ENTRY" "${MODE[@]}" "$@"
fi
BUNDLED="${HOME:-}/.local/share/pi-node/current/bin/node"
if [[ -x "$BUNDLED" ]] && compatible_node "$BUNDLED"; then
  exec "$BUNDLED" "$ENTRY" "${MODE[@]}" "$@"
fi
if ! command -v npm >/dev/null 2>&1; then
  printf '%s\n' 'Node >=22.19 or a working npm (for the Node 24 fallback) is required.' >&2
  exit 1
fi
printf '%s\n' 'Using npm-provided Node 24 (may download on first use; system Node unchanged).' >&2
exec npm exec --yes --package=node@24 -- node "$ENTRY" "${MODE[@]}" "$@"
