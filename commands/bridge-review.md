Run a code review on a file or directory using the bridge pipeline (Gemini → Codex).

<instructions>
If $ARGUMENTS is empty, ask the user: "请输入要审查的文件或目录路径："and wait for their response before running anything.

If $ARGUMENTS is provided, use the Bash tool with timeout 600000 to run:
```
aitools review $ARGUMENTS
```
The timeout parameter for the Bash tool call MUST be set to 600000 (10 minutes). This is required because the Gemini + Codex pipeline can take several minutes for large files.
Then present the full output to the user.
</instructions>
