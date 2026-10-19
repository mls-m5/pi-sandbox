# Run: source ./env.sh
# Adds this checkout's bin directory to PATH in the current Bash terminal only.
export PATH="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/bin:$PATH"
