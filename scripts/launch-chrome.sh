#!/usr/bin/env bash
# Start Google Chrome with remote debugging enabled so the MCP server can attach in "cdp" mode:
#   LINKEDIN_MCP_BROWSER_MODE=cdp
#
# Chrome 136+ refuses --remote-debugging-port on the DEFAULT user-data-dir, so this uses the same dedicated
# profile directory the MCP server uses in persistent mode (sign in once; cookies persist there).
#
# Usage:  ./scripts/launch-chrome.sh            (macOS)
# Env:    LINKEDIN_MCP_DATA_DIR (default ~/.linkedin-applicants-mcp), LINKEDIN_MCP_CDP_URL (default http://127.0.0.1:9222)
set -euo pipefail

DATA_DIR="${LINKEDIN_MCP_DATA_DIR:-$HOME/.linkedin-applicants-mcp}"
DATA_DIR="${DATA_DIR/#\~/$HOME}"
PROFILE_DIR="$DATA_DIR/chrome-profile"
CDP_URL="${LINKEDIN_MCP_CDP_URL:-http://127.0.0.1:9222}"
PORT="${CDP_URL##*:}"
PORT="${PORT%%/*}"

mkdir -p "$PROFILE_DIR"

case "$(uname -s)" in
  Darwin)
    CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    ;;
  Linux)
    CHROME="$(command -v google-chrome || command -v google-chrome-stable || command -v chromium-browser || command -v chromium || true)"
    ;;
  *)
    # Windows (Git Bash / WSL): adjust the path if needed
    CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"
    ;;
esac

if [[ -z "${CHROME}" || ! -e "${CHROME}" ]]; then
  echo "Google Chrome not found (looked at: ${CHROME:-<none>}). Install Chrome or edit this script." >&2
  exit 1
fi

echo "Starting Chrome with remote debugging on port ${PORT}" >&2
echo "  profile: ${PROFILE_DIR}" >&2
echo "Sign in to LinkedIn in this window once; then set LINKEDIN_MCP_BROWSER_MODE=cdp for the MCP server." >&2

exec "${CHROME}" \
  --remote-debugging-port="${PORT}" \
  --user-data-dir="${PROFILE_DIR}" \
  --no-first-run \
  --no-default-browser-check \
  "https://www.linkedin.com/feed/"
