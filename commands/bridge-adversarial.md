Run an adversarial code review on a file or directory using the bridge pipeline (Gemini → Codex).

The adversarial review actively tries to find reasons the code should NOT ship — it challenges design decisions, surfaces hidden failure paths, and prioritises high-impact risks.

<instructions>
If $ARGUMENTS is empty, ask the user: "请输入要进行激进审查的文件或目录路径："and wait for their response before running anything.

If $ARGUMENTS is provided, use the Bash tool to run:
```
aitools adversarial $ARGUMENTS
```
Then present the full output to the user.
</instructions>
