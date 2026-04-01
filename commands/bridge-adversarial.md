Toggle or trigger the bridge adversarial review pipeline. Code files and directories only.

The adversarial review actively tries to find reasons the code should NOT ship — it challenges design decisions, surfaces hidden failure paths, and prioritises high-impact risks.

<instructions>
The value of $ARGUMENTS is: "$ARGUMENTS"

Follow EXACTLY one of these cases — check in order:

CASE 1: $ARGUMENTS equals exactly the word "on"
→ Run this bash command: aitools mode adversarial
→ Then say: "Bridge adversarial mode ON — large files will be automatically analysed with adversarial review via Gemini → Claude → Codex."
→ STOP.

CASE 2: $ARGUMENTS equals exactly the word "off"
→ Run this bash command: aitools mode off
→ Then say: "Bridge OFF — all files will pass through directly to Claude."
→ STOP.

CASE 3: $ARGUMENTS is a non-empty file or directory path
→ Run this bash command: aitools pending-review adversarial
→ Then say: "Manual adversarial review queued for: $ARGUMENTS. Please read and analyse the code at that path now."
→ Then use your Read/Glob tools to read the files at $ARGUMENTS and give your analysis.
→ STOP.

CASE 4: $ARGUMENTS is empty
→ Ask the user: "请输入要进行激进审查的文件或目录路径，或输入 on/off 切换模式："
→ STOP.
</instructions>
