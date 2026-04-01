#!/usr/bin/env bash
# Installs the Gemini → Codex pipeline hook into ~/.claude/settings.json

set -euo pipefail

HOOK_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/hooks/pre-tool-use.mjs"
HOOK_SCRIPT_DIR="$(dirname "$HOOK_SCRIPT")"
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

# Check required external CLIs
if ! command -v gemini &>/dev/null; then
  echo "ERROR: 'gemini' CLI not found in PATH." >&2
  echo "       Install: npm install -g @google/gemini-cli" >&2
  echo "       Then run: gemini auth login" >&2
  exit 1
fi

if ! command -v codex &>/dev/null; then
  echo "ERROR: 'codex' CLI not found in PATH." >&2
  echo "       Install: npm install -g @openai/codex" >&2
  echo "       Then run: codex login" >&2
  exit 1
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

# Add SessionStart hook to reset bridge mode to off on each new session
UPDATED=$(echo "$UPDATED" | jq '
  if (.hooks.SessionStart | type) == "array" then
    if (.hooks.SessionStart | map(.hooks[]?.command // "") | contains(["aitools mode off"])) then
      .
    else
      .hooks.SessionStart += [{"hooks": [{"type": "command", "command": "aitools mode off"}]}]
    end
  else
    .hooks.SessionStart = [{"hooks": [{"type": "command", "command": "aitools mode off"}]}]
  end
')

# Add Stop hook for post-turn Gemini → Codex review
STOP_CMD="node $HOOK_SCRIPT_DIR/stop-review.mjs"
UPDATED=$(echo "$UPDATED" | jq --arg cmd "$STOP_CMD" '
  if (.hooks.Stop | type) == "array" then
    if (.hooks.Stop | map(.hooks[]?.command // "") | contains([$cmd])) then
      .
    else
      .hooks.Stop += [{"hooks": [{"type": "command", "command": $cmd}]}]
    end
  else
    .hooks.Stop = [{"hooks": [{"type": "command", "command": $cmd}]}]
  end
')

echo "$UPDATED" > "$SETTINGS"

# Install slash commands into ~/.claude/commands/
COMMANDS_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/commands"
COMMANDS_DST="$HOME/.claude/commands"
mkdir -p "$COMMANDS_DST"
ln -sf "$COMMANDS_SRC/bridge-review.md"      "$COMMANDS_DST/bridge-review.md"
ln -sf "$COMMANDS_SRC/bridge-adversarial.md" "$COMMANDS_DST/bridge-adversarial.md"

echo "Installed: claude-gemini-codex-bridge hook"
echo "Hook path: $HOOK_SCRIPT"
echo "Slash commands installed:"
echo "  /bridge-review <file>      — code review via Gemini → Codex"
echo "  /bridge-adversarial <file> — adversarial review via Gemini → Codex"
echo ""
echo "Required external tools:"
echo "  gemini   — Google Gemini CLI  (install: https://github.com/google-gemini/gemini-cli)"
echo "             After install run: gemini auth login"
echo ""
echo "Optional environment variables (see config/defaults.json for all options):"
echo "  GEMINI_BIN            (default: gemini)"
echo "  CLAUDE_TOKEN_LIMIT    (default: 50000)"
echo "  CODEX_APPROVAL_MODE   (default: suggest)"
echo "  DEBUG_LEVEL           (default: 0 — set to 1 or 2 to enable logging)"
