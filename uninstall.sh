#!/usr/bin/env bash
# Removes the Gemini → Codex pipeline hook from ~/.claude/settings.json

set -euo pipefail

HOOK_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/hooks/pre-tool-use.mjs"
SETTINGS="$HOME/.claude/settings.json"

if [ ! -f "$SETTINGS" ]; then
  echo "Nothing to uninstall ($SETTINGS not found)"
  exit 0
fi

UPDATED=$(jq --arg cmd "node $HOOK_SCRIPT" '
  if (.hooks.PreToolUse | type) == "array" then
    .hooks.PreToolUse = [
      .hooks.PreToolUse[] |
      select(.hooks[]?.command != $cmd)
    ]
  else
    .
  end
' "$SETTINGS")

echo "$UPDATED" > "$SETTINGS"

# Remove slash commands
rm -f "$HOME/.claude/commands/bridge-review.md"
rm -f "$HOME/.claude/commands/bridge-adversarial.md"

echo "Uninstalled: claude-gemini-codex-bridge hook and slash commands"
