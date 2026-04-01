Run a code review on a file or directory using the bridge pipeline (Gemini → Codex).

<instructions>
If $ARGUMENTS is empty, ask the user: "请输入要审查的文件或目录路径："and wait for their response before running anything.

If $ARGUMENTS is provided, use the Bash tool to run:
```
aitools review $ARGUMENTS
```
Then present the full output to the user.
</instructions>
