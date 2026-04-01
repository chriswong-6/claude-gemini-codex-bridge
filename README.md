# claude-gemini-codex-bridge

A Claude Code `PreToolUse` hook that chains **Gemini** and **Codex** sequentially when a tool call targets files too large for Claude's context window.

## How it works

```
Claude triggers Read / Grep / Glob / Task
          │
          ▼
   Token estimate > 50k?
          │
    No ───┴─── Yes
    │               │
  (pass through)    ▼
              Gemini 1.5 Pro
          (summarise large context)
                    │
                    ▼
                  Codex
          (deep analysis on summary)
                    │
                    ▼
          Result injected back into Claude
```

If Codex is unavailable, the Gemini summary is returned as fallback.  
Results are SHA-256 cached (TTL: 1 hour) so repeated calls on the same files are instant.

## Requirements

| Dependency | Notes |
|---|---|
| Node.js ≥ 18 | built-in `fetch` required |
| Claude Code CLI | the host that runs the hook — **must be installed manually** |
| `gemini` CLI | Google Gemini CLI — **must be installed manually** |
| `codex` CLI | OpenAI Codex CLI — **must be installed manually** |
| `jq` | for `install.sh` |
| `pdftotext` | for PDF support — `brew install poppler` (optional but recommended) |

> **None of these tools are installed automatically by this project.**
> You must install and authenticate all three before running `install.sh`.
>
> **Note on PDF support:** Without `pdftotext`, PDFs are processed via printable-string extraction (readable fragments only). Install poppler for full, structured PDF text extraction.

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

Codex is required. Without it the pipeline is incomplete and `install.sh` will exit with an error.

### poppler (PDF support)

```bash
brew install poppler
```

Optional. Without `pdftotext`, PDFs are processed via printable-string extraction (readable fragments only). Install poppler for full, structured PDF text extraction.

## Step 2 — Install the bridge

```bash
git clone https://github.com/chriswong-6/claude-gemini-codex-bridge
cd claude-gemini-codex-bridge
npm link        # registers the `aitools` command globally
bash install.sh
```

`npm link` registers the `aitools` CLI so you can run `aitools start`, `aitools live`, and `aitools trace` from any directory.

The script adds a `PreToolUse` hook entry to `~/.claude/settings.json` and installs the slash commands into `~/.claude/commands/`.

## Step 3 — Start using it

```bash
claude
```

That's it. The bridge runs automatically in the background — no extra commands needed. Whenever Claude reads a file larger than 50k tokens, the hook intercepts the call and routes it through Gemini → Codex before returning the result.

## Usage

### Automatic pipeline

The bridge triggers automatically when Claude reads a file exceeding the token threshold (default: 50k tokens ≈ 200 KB):

- **Small file** → Claude handles directly
- **Large file** → Gemini summarises → Codex analyses → result returned to Claude

### Manual review commands

Two slash commands are available inside Claude Code. Each supports three usage patterns:

| Command | Description |
|---|---|
| `/bridge-review <file\|dir>` | Standard code review — bugs, risks, quality issues |
| `/bridge-adversarial <file\|dir>` | Adversarial review — actively challenges design decisions and surfaces failure paths |

**One-time review** (bridge stays off after):
```
/bridge-review src/auth/middleware.js
/bridge-adversarial src/payments/processor.js
```

**Enable auto mode** (all large files in this session are reviewed automatically):
```
/bridge-review on
/bridge-adversarial on
```

**Disable** (stop auto review):
```
/bridge-review off
```

> **Session behaviour:** every new Claude Code window starts with bridge mode **off** (reset by `SessionStart` hook). Enabling `on` in one window does not affect other windows.

### Adjusting the token threshold

The token threshold controls when the automatic pipeline triggers.

**Default: 50,000 tokens ≈ 200 KB of text**

**Method 1 — Environment variable (per session):**

```bash
export CLAUDE_TOKEN_LIMIT=20000   # trigger pipeline for files > 20k tokens (~80 KB)
claude
```

Add to `~/.zshenv` to make it permanent:

```bash
echo 'export CLAUDE_TOKEN_LIMIT=20000' >> ~/.zshenv
```

**Method 2 — Edit the default config (permanent for all users):**

Edit `config/defaults.json`:

```json
"routing": {
  "claudeTokenLimit": 20000
}
```

| Value | Approx. file size | Effect |
|---|---|---|
| `10000` | ~40 KB | Almost all non-trivial files go through Gemini → Codex |
| `20000` | ~80 KB | Medium files (100–200 line scripts) trigger the pipeline |
| `50000` | ~200 KB | Default — only large files and documents |
| `100000` | ~400 KB | Only very large files trigger the pipeline |

**Lower = more Gemini/Codex calls, longer wait times, higher API cost.**  
**Higher = faster for most files, but large files stay with Claude.**

### Monitoring with trace

To verify the pipeline is working, open a second terminal and run:

```bash
aitools trace
```

Every time the bridge fires, the trace window shows the data flow within ~100ms.

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

**Large file (full pipeline):**

```
────────────────────────────────────────────────────
  14:35:12  ·  Read  ·  1 file(s)
────────────────────────────────────────────────────

  Described:
  Claude ─→ Gemini ─→ Codex ─→ Claude

  Actual:
  Claude ─→ Gemini ✓ ─→ Codex ✓ ─→ Claude ✓

  Gemini  ok   1 file(s) → 3241 chars  (12043ms)
  Codex   ok   3241 chars in → 891 chars out  (8120ms)
  Cache   miss    Total 20163ms

  ✓  Matches described workflow
```

Traces are stored at `~/.claude-gemini-codex-bridge/traces/`.

## Configuration

All options can be overridden via environment variables. Defaults are in `config/defaults.json`.

| Variable | Default | Description |
|---|---|---|
| `GEMINI_BIN` | `gemini` | Path to the gemini CLI binary |
| `CLAUDE_TOKEN_LIMIT` | `50000` | Token threshold that triggers the pipeline |
| `GEMINI_TOKEN_LIMIT` | `800000` | Upper bound; files larger than this are passed through |
| `MAX_TOTAL_SIZE_BYTES` | `10485760` | Hard 10 MB cap |
| `CODEX_APPROVAL_MODE` | `suggest` | `suggest` / `auto-edit` / `full-auto` |
| `CODEX_BIN` | `codex` | Path to the codex binary |
| `CACHE_TTL_SECONDS` | `3600` | Cache TTL (1 hour) |
| `DEBUG_LEVEL` | `0` | `0`=off `1`=basic `2`=verbose |
| `LOG_DIR` | `~/.claude-gemini-codex-bridge/logs` | Log directory |

## Uninstall the bridge

```bash
bash uninstall.sh
```

## Testing

No API keys or external services are required — all external calls are mocked.

### Diagnostic check

Quickly verifies that every component is present and functional:

```bash
node test/check.mjs
```

Add `--live` to also ping the real Gemini API:

```bash
node test/check.mjs --live
```

### Unit tests

```bash
node --test test/unit.test.mjs
```

### Integration tests

```bash
node --test test/integration.test.mjs
```

### Run everything (mock)

```bash
aitools start
```

### Live tests (real CLIs)

Requires gemini and codex CLIs installed and authenticated:

```bash
gemini auth login
codex login

aitools live
```

### CI

Tests run automatically on every push and pull request via GitHub Actions across Node.js 18, 20, and 22. See `.github/workflows/test.yml`.

## Project structure

```
claude-gemini-codex-bridge/
├── commands/
│   ├── bridge-adversarial.md  # /bridge-adversarial slash command template
│   └── bridge-review.md       # /bridge-review slash command template
├── config/
│   └── defaults.json          # Default configuration values
├── hooks/
│   ├── pre-tool-use.mjs       # Hook entry point (reads stdin, orchestrates pipeline)
│   ├── bridge-run.mjs         # Standalone runner for manual review commands
│   └── lib/
│       ├── cache.mjs          # SHA-256 content-based cache
│       ├── codex.mjs          # Codex CLI integration
│       ├── config.mjs         # Config loader (defaults + env overrides)
│       ├── gemini.mjs         # Gemini CLI client
│       ├── logger.mjs         # Stderr/file logger (never pollutes stdout)
│       ├── paths.mjs          # @-notation path resolver + file extractor
│       ├── prompt.mjs         # Interactive degradation prompts via /dev/tty
│       ├── router.mjs         # Routing decision engine (token estimation)
│       └── tracer.mjs         # Writes JSON trace files for aitools trace
├── install.sh
├── uninstall.sh
└── package.json
```

## Credits

Inspired by:
- [tkaufmann/claude-gemini-bridge](https://github.com/tkaufmann/claude-gemini-bridge) — PreToolUse hook pattern, routing logic, caching
- [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) — Codex integration architecture
