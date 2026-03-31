#!/usr/bin/env bash
# Installs the Gemini → Codex pipeline hook into ~/.claude/settings.json

set -euo pipefail

HOOK_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/hooks/pre-tool-use.mjs"
SETTINGS="$HOME/.claude/settings.json"

if [ ! -f "$HOOK_SCRIPT" ]; then
  echo "ERROR: Hook script not found at $HOOK_SCRIPT" >&2
  exit 1
fi

# Check required tools
for bin in node jq; do
  if ! command -v "$bin" &>/dev/null; then
    echo "ERROR: '$bin' is required but not found in PATH" >&2
    exit 1
  fi
done

# Check Node.js version >= 18
NODE_MAJOR=$(node -e "process.stdout.write(process.versions.node.split('.')[0])")
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "ERROR: Node.js >= 18 required (found $(node --version))" >&2
  exit 1
fi

# Warn if env vars are missing (non-fatal — user may set them later)
[[ -z "${GEMINI_API_KEY:-}" ]] && echo "WARN: GEMINI_API_KEY is not set. Set it before using the bridge."
if ! command -v codex &>/dev/null; then
  echo "WARN: 'codex' binary not found in PATH. Install it before using the bridge."
fi

# Create settings file if it doesn't exist
mkdir -p "$(dirname "$SETTINGS")"
if [ ! -f "$SETTINGS" ]; then
  echo '{}' > "$SETTINGS"
fi

# Merge the hook into settings.json using jq
HOOK_ENTRY=$(jq -n --arg cmd "node $HOOK_SCRIPT" \
  '[{"hooks": {"PreToolUse": [{"matcher": "", "hooks": [{"type": "command", "command": $cmd}]}]}}]' \
  | jq '.[0]')

UPDATED=$(jq --argjson hook "$HOOK_ENTRY" '
  . as $settings |
  ($hook.hooks.PreToolUse[0]) as $new_hook |

  # Ensure hooks.PreToolUse array exists
  if (.hooks.PreToolUse | type) == "array" then
    # Check if this hook is already registered
    if (.hooks.PreToolUse | map(.hooks[]?.command // "") | contains([$new_hook.hooks[0].command])) then
      .   # already present — no-op
    else
      .hooks.PreToolUse += [$new_hook]
    end
  else
    .hooks.PreToolUse = [$new_hook]
  end
' "$SETTINGS")

echo "$UPDATED" > "$SETTINGS"

echo "Installed: claude-gemini-codex-bridge hook"
echo "Hook path: $HOOK_SCRIPT"
echo ""
echo "Required environment variables:"
echo "  GEMINI_API_KEY   — your Google Gemini API key"
echo ""
echo "Optional environment variables (see config/defaults.json for all options):"
echo "  CLAUDE_TOKEN_LIMIT    (default: 50000)"
echo "  GEMINI_MODEL          (default: gemini-1.5-pro)"
echo "  CODEX_APPROVAL_MODE   (default: suggest)"
echo "  DEBUG_LEVEL           (default: 0 — set to 1 or 2 to enable logging)"
