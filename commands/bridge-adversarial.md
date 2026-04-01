Run an adversarial code review on $ARGUMENTS using the bridge pipeline (Gemini → Codex), regardless of file size.

The adversarial review actively tries to find reasons the code should NOT ship — it challenges design decisions, surfaces hidden failure paths, and prioritises high-impact risks over stylistic concerns.

Use the Bash tool to run:
```
aitools adversarial $ARGUMENTS
```

Then present the full output to the user.
