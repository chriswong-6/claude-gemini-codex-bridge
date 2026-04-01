Toggle or run the bridge adversarial review pipeline (Gemini → Codex).

The adversarial review actively tries to find reasons the code should NOT ship — it challenges design decisions, surfaces hidden failure paths, and prioritises high-impact risks.

**Toggle mode** (persists across sessions):
- `/bridge-adversarial on`  — enable adversarial auto-review: large files get adversarial analysis
- `/bridge-adversarial off` — disable bridge entirely: all files pass through directly

**One-time review** (runs immediately on a specific path):
- `/bridge-adversarial <path>` — adversarial review a file or directory now

<instructions>
Check $ARGUMENTS:

If $ARGUMENTS is "on":
  Use the Bash tool to run: aitools mode adversarial
  Then tell the user: "Bridge adversarial mode ON — large files will be automatically analysed with adversarial review via Gemini → Codex."

If $ARGUMENTS is "off":
  Use the Bash tool to run: aitools mode off
  Then tell the user: "Bridge OFF — all files will pass through directly to Claude."

If $ARGUMENTS is a file or directory path (not "on" or "off"):
  Use the Bash tool with timeout 600000 to run: aitools adversarial $ARGUMENTS
  Then present the full output to the user.

If $ARGUMENTS is empty:
  Ask the user: "请选择操作：\n1. 开启激进审查模式（on）\n2. 关闭 bridge（off）\n3. 对特定路径运行激进审查（输入路径）"
  Then execute the appropriate command based on their response.
</instructions>
