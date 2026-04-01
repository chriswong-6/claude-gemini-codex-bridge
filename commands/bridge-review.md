Toggle or run the bridge code review pipeline (Gemini → Codex).

**Toggle mode** (persists across sessions):
- `/bridge-review on`  — enable auto-review: large files are automatically reviewed
- `/bridge-review off` — disable bridge entirely: all files pass through directly

**One-time review** (runs immediately on a specific path):
- `/bridge-review <path>` — review a file or directory now

<instructions>
Check $ARGUMENTS:

If $ARGUMENTS is "on":
  Use the Bash tool to run: aitools mode review
  Then tell the user: "Bridge review mode ON — large files will be automatically reviewed via Gemini → Codex."

If $ARGUMENTS is "off":
  Use the Bash tool to run: aitools mode off
  Then tell the user: "Bridge OFF — all files will pass through directly to Claude."

If $ARGUMENTS is a file or directory path (not "on" or "off"):
  Use the Bash tool with timeout 600000 to run: aitools review $ARGUMENTS
  Then present the full output to the user.

If $ARGUMENTS is empty:
  Ask the user: "请选择操作：\n1. 开启自动审查模式（on）\n2. 关闭 bridge（off）\n3. 对特定路径运行审查（输入路径）"
  Then execute the appropriate command based on their response.
</instructions>
