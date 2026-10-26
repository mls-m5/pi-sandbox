# Run: source ./env.sh
# Adds this checkout's bin directory and, when installed, Pi's bundled Node to PATH.
# Changes apply to the current Bash terminal only; no shell startup files are edited.
PIS_CHECKOUT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PI_NODE_BIN="${HOME:-}/.local/share/pi-node/current/bin"
if [[ -x "$PI_NODE_BIN/node" ]]; then
  export PATH="$PI_NODE_BIN:$PATH"
fi
export PATH="$PIS_CHECKOUT/bin:$PATH"
unset PIS_CHECKOUT PI_NODE_BIN
