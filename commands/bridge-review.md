Toggle or run the bridge code review pipeline (Gemini → Codex).

<instructions>
The value of $ARGUMENTS is: "$ARGUMENTS"

Follow EXACTLY one of these cases — check in order:

CASE 1: $ARGUMENTS equals exactly the word "on"
→ Run this bash command: aitools mode review
→ Then say: "Bridge review mode ON — large files will be automatically reviewed via Gemini → Codex."
→ STOP. Do not ask for a path.

CASE 2: $ARGUMENTS equals exactly the word "off"
→ Run this bash command: aitools mode off
→ Then say: "Bridge OFF — all files will pass through directly to Claude."
→ STOP. Do not ask for a path.

CASE 3: $ARGUMENTS is a non-empty string that is NOT "on" or "off"
→ Treat it as a file or directory path.
→ Run this bash command with timeout 600000: aitools review $ARGUMENTS
→ Present the full output to the user.

CASE 4: $ARGUMENTS is empty
→ Ask the user: "请选择操作：输入 on（开启自动审查）、off（关闭 bridge）或文件路径（立即审查）"
→ Wait for their input, then execute the matching case above.
</instructions>
