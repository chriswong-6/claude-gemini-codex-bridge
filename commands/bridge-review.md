Toggle or run the bridge code review pipeline (Gemini → Codex). Code files and directories only.

<instructions>
The value of $ARGUMENTS is: "$ARGUMENTS"

Follow EXACTLY one of these cases — check in order:

CASE 1: $ARGUMENTS equals exactly the word "on"
→ Run this bash command: aitools mode review
→ Then say: "Bridge review mode ON — large files will be automatically reviewed via Gemini → Codex."
→ STOP.

CASE 2: $ARGUMENTS equals exactly the word "off"
→ Run this bash command: aitools mode off
→ Then say: "Bridge OFF — all files will pass through directly to Claude."
→ STOP.

CASE 3: $ARGUMENTS is a non-empty file or directory path
→ Run this bash command with timeout 600000: aitools review $ARGUMENTS
→ Present the full output to the user.

CASE 4: $ARGUMENTS is empty
→ Ask the user: "请输入要审查的文件或目录路径："
→ Wait for their input, then run: aitools review <input>
</instructions>
