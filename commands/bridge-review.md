Toggle or run the bridge review pipeline (Gemini → Codex).

Works with code files, directories, OR any free-form text/idea.

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

CASE 3: $ARGUMENTS is non-empty and looks like a file or directory path (starts with /, ./, ~/, or contains a file extension like .mjs .js .py .ts .go .md etc.)
→ Run this bash command with timeout 600000: aitools review $ARGUMENTS
→ Present the full output to the user.

CASE 4: $ARGUMENTS is non-empty and does NOT look like a file path (it is free-form text, an idea, a question, or anything else)
→ Run this bash command with timeout 600000: aitools review --text="$ARGUMENTS"
→ Present the full output to the user.

CASE 5: $ARGUMENTS is empty
→ Ask the user: "请输入要审查的内容：文件路径、目录路径，或直接输入想法/文字"
→ Wait for their input, then execute the matching case above.
</instructions>
