# claude-gemini-codex-bridge

A Claude Code hook pipeline that chains **Gemini** and **Codex** to give Claude richer context and post-turn code review.

## How it works

The pipeline has two stages that fire at different points in a turn:

```
┌─────────────────────────────────────────────────────────────┐
│  Stage 1 — Pre-tool-use (when Claude reads a file)          │
│                                                             │
│  Claude tries to Read a file                                │
│          │                                                  │
│    File > token threshold?  OR  manual /bridge-review set?  │
│          │                                                  │
│    No ───┴─── Yes                                           │
│    │               │                                        │
│  (pass through)    ▼                                        │
│              Gemini summarises file                         │
│              → summary injected as Claude's context         │
│              → gemini-used flag set                         │
└─────────────────────────────────────────────────────────────┘
         │
         ▼
  Claude answers using Gemini summary (may write code)
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│  Stage 2 — Stop hook (after Claude finishes responding)     │
│                                                             │
│  Trigger: mode=on  OR  gemini-used flag  OR  pending-review │
│          │                                                  │
│    Files to review?                                         │
│    ├── Claude wrote/modified files → review those           │
│    ├── Manual /bridge-review <path> → review those paths    │
│    └── Nothing → approve, done                              │
│          │                                                  │
│          ▼                                                  │
│       Codex reviews file contents directly                  │
│       → analysis returned to Claude                         │
│       → Claude revises its response if needed               │
└─────────────────────────────────────────────────────────────┘
```

**Summary:**
- **Gemini** runs *before* Claude answers — handles large files that would exceed Claude's context
- **Codex** runs *after* Claude answers — reviews the code Claude wrote or the files you pointed to
- Results are SHA-256 cached (TTL: 1 hour) so repeated calls on the same files are instant

## Trigger conditions

Any one of these three conditions activates the full pipeline:

| Condition | Gemini (pre) | Codex (post) |
|---|---|---|
| `mode=off`, file ≤ threshold | ✗ | ✗ |
| `mode=off`, file > threshold | ✓ auto | ✓ if Claude wrote files |
| `mode=on` (review/adversarial) | ✓ if file > threshold | ✓ if Claude wrote files |
| `/bridge-review <path>` (manual) | ✓ forced | ✓ reviews specified path |

## Requirements

| Dependency | Notes |
|---|---|
| Node.js ≥ 18 | built-in `fetch` required |
| Claude Code CLI | the host that runs the hook — **must be installed manually** |
| `gemini` CLI | Google Gemini CLI — **must be installed manually** |
| `codex` CLI | OpenAI Codex CLI — **must be installed manually** |
| `jq` | for `install.sh` |
| `pdftotext` | for PDF support — `brew install poppler` (optional) |

> **None of these tools are installed automatically by this project.**
> You must install and authenticate all three before running `install.sh`.

## Step 1 — Install the tools manually

### Claude Code

Download and install from [claude.ai/download](https://claude.ai/download), then sign in with your Anthropic account.

Claude Code creates `~/.claude/settings.json` on first run — this file is required by `install.sh`.

### Gemini CLI

```bash
npm install -g @google/gemini-cli
gemini   # select "Login with Google" → complete browser OAuth
```

On first run, `gemini` opens an interactive prompt asking how to authenticate.
Select **"Login with Google"** and complete the browser flow — no API key needed.

> **Google Workspace accounts** require an additional env var pointing to a
> Google Cloud Project with the [Gemini for Google Cloud API](https://console.cloud.google.com/apis/library/cloudaicompanion.googleapis.com) enabled:
> ```bash
> export GOOGLE_CLOUD_PROJECT=your-project-id   # add to ~/.zshenv to persist
> ```

> **Alternative — API Key:** if you prefer not to use OAuth, create a free key at
> [aistudio.google.com/apikey](https://aistudio.google.com/apikey) and run
> `gemini`, then select **"Use Gemini API Key"**.

### Codex CLI

```bash
npm install -g @openai/codex
codex login          # sign in with your OpenAI account
```

### poppler (PDF support, optional)

```bash
brew install poppler
```

Without `pdftotext`, PDFs are processed via printable-string extraction only.

## Step 2 — Install the bridge

```bash
git clone https://github.com/chriswong-6/claude-gemini-codex-bridge
cd claude-gemini-codex-bridge
npm link        # registers the `aitools` command globally
bash install.sh
```

`install.sh` adds three hooks to `~/.claude/settings.json`:
- `PreToolUse` — Gemini context injection for large files
- `Stop` — Codex post-turn review
- `SessionStart` — resets bridge mode to `off` on each new window

It also installs the slash commands into `~/.claude/commands/`.

## Step 3 — Start using it

```bash
claude
```

The bridge runs automatically in the background. Every new session starts with bridge mode **off**. Enable it per-session with `/bridge-review on`, or use it one-shot with `/bridge-review <path>`.

## Usage

### Bridge modes

| Command | Effect |
|---|---|
| `/bridge-review on` | Enable auto review mode for this session |
| `/bridge-adversarial on` | Enable adversarial review mode for this session |
| `/bridge-review off` | Disable — bridge stays off for remainder of session |

> **Session behaviour:** every new Claude Code window starts with mode **off**. Enabling `on` in one window does not affect other windows.

### One-shot manual review

Run the full pipeline on a specific file or directory without changing your session mode:

```
/bridge-review src/auth/middleware.js
/bridge-adversarial src/payments/processor.js
```

**What happens:**
1. Bridge queues a pending review for that path
2. Claude reads the files — Gemini summarises them regardless of size
3. Claude gives its analysis
4. Codex reviews the specified files and Claude revises if needed

### Automatic pipeline (when mode=on)

With mode on, the bridge fires automatically whenever:
- Claude reads a file exceeding the token threshold → Gemini injects context before Claude answers
- Claude writes/modifies any file → Codex reviews after Claude responds

### Adjusting the token threshold

The token threshold controls when Gemini automatically kicks in for large files.

| Lines of code | Approx tokens | `CLAUDE_TOKEN_LIMIT` |
|---|---|---|
| ~50 lines | 500 | `500` |
| ~100–200 lines | 1,000 | `1000` ← **default** |
| ~500 lines | 5,000 | `5000` |
| ~1,000 lines | 10,000 | `10000` |
| ~5,000 lines | 50,000 | `50000` |

*Rule of thumb: 1 line ≈ 10 tokens*

**Method 1 — Environment variable (per session):**

```bash
export CLAUDE_TOKEN_LIMIT=5000   # trigger for files > ~500 lines
claude
```

Add to `~/.zshenv` to make it permanent.

**Method 2 — Edit the default config:**

```json
"routing": {
  "claudeTokenLimit": 1000
}
```

### Monitoring with trace

Open a second terminal to watch the pipeline in real time:

```bash
aitools trace
```

**Small file (pass-through):**
```
────────────────────────────────────────────────────
  14:32:05  ·  Read  ·  1 file(s)
────────────────────────────────────────────────────

  Described:
  Claude ─→ Claude (small file, direct)

  Actual:
  Claude ─→ Claude ✓

  ✓  Matches described workflow
```

**Large file (Gemini context injection):**
```
────────────────────────────────────────────────────
  14:35:12  ·  Read  ·  1 file(s)
────────────────────────────────────────────────────

  Described:
  Claude ─→ Gemini ─→ Claude

  Actual:
  Claude ─→ Gemini ✓ ─→ Claude ✓

  Gemini  ok   1 file(s) → 3241 chars  (12043ms)
  Cache   miss    Total 12043ms

  ✓  Matches described workflow
```

**Post-turn Codex review:**
```
────────────────────────────────────────────────────
  14:36:01  ·  Stop  ·  2 file(s)
────────────────────────────────────────────────────

  Described:
  [post-turn: review]  Claude ─→ Codex ─→ Claude (stop review)

  Actual:
  Claude ─→ Codex ✓ ─→ Claude ✓

  Codex   ok   8432 chars in → 1204 chars out  (9870ms)
  Total 9870ms

  ✓  Matches described workflow
```

Traces are stored at `~/.claude-gemini-codex-bridge/traces/`.

## Configuration

All options can be overridden via environment variables. Defaults are in `config/defaults.json`.

| Variable | Default | Description |
|---|---|---|
| `GEMINI_BIN` | `gemini` | Path to the gemini CLI binary |
| `CLAUDE_TOKEN_LIMIT` | `1000` | Token threshold that triggers Gemini context injection |
| `GEMINI_TOKEN_LIMIT` | `800000` | Upper bound; files larger than this are passed through |
| `MAX_TOTAL_SIZE_BYTES` | `10485760` | Hard 10 MB cap |
| `CODEX_APPROVAL_MODE` | `suggest` | `suggest` / `auto-edit` / `full-auto` |
| `CODEX_BIN` | `codex` | Path to the codex binary |
| `CACHE_TTL_SECONDS` | `3600` | Cache TTL (1 hour) |
| `DEBUG_LEVEL` | `0` | `0`=off `1`=basic `2`=verbose |
| `LOG_DIR` | `~/.claude-gemini-codex-bridge/logs` | Log directory |

## Uninstall

```bash
bash uninstall.sh
```

## Testing

No API keys or external services are required — all external calls are mocked.

```bash
aitools start    # unit + integration tests (mock)
aitools live     # live tests against real CLIs (auth required)
```

Tests run automatically on every push and pull request via GitHub Actions across Node.js 18, 20, and 22.

## Project structure

```
claude-gemini-codex-bridge/
├── commands/
│   ├── bridge-adversarial.md  # /bridge-adversarial slash command
│   └── bridge-review.md       # /bridge-review slash command
├── config/
│   └── defaults.json          # Default configuration values
├── hooks/
│   ├── pre-tool-use.mjs       # Stage 1: Gemini context injection
│   ├── stop-review.mjs        # Stage 2: Codex post-turn review
│   └── lib/
│       ├── cache.mjs          # SHA-256 content-based cache
│       ├── codex.mjs          # Codex CLI integration
│       ├── config.mjs         # Config loader (defaults + env overrides)
│       ├── gemini.mjs         # Gemini CLI client
│       ├── gemini-flag.mjs    # Flag: Gemini was used this turn
│       ├── logger.mjs         # Stderr/file logger
│       ├── mode.mjs           # Bridge mode state (review/adversarial/off)
│       ├── paths.mjs          # File path extractor from tool calls
│       ├── pending-review.mjs # Flag: manual /bridge-review <path> queued
│       ├── router.mjs         # Routing decision (token estimation)
│       ├── session-files.mjs  # Tracks files Claude writes this turn
│       └── tracer.mjs         # Writes JSON trace files
├── bin/
│   └── aitools.mjs            # aitools CLI (mode, trace, pending-review)
├── test/
│   ├── trace.mjs              # Live trace viewer
│   ├── check.mjs              # Diagnostic check
│   ├── unit.test.mjs
│   └── integration.test.mjs
├── install.sh
├── uninstall.sh
└── package.json
```

## Credits

Inspired by:
- [tkaufmann/claude-gemini-bridge](https://github.com/tkaufmann/claude-gemini-bridge) — PreToolUse hook pattern, routing logic, caching
- [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) — Codex integration architecture
