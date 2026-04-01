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
> **Note on PDF support:** gemini CLI ≥ 0.35 interprets `@` bytes in stdin as file-path references, which causes it to hang on binary PDF content. The bridge uses `pdftotext` (part of `poppler`) to extract clean text before sending to Gemini. Without it, PDFs are still processed via printable-string extraction but results may be limited for compressed PDFs.

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

## Step 2 — Install the bridge

```bash
git clone https://github.com/chriswong-6/claude-gemini-codex-bridge
cd claude-gemini-codex-bridge
npm link        # registers the `aitools` command globally
bash install.sh
```

`npm link` registers the `aitools` CLI so you can run `aitools start`, `aitools live`, and `aitools trace` from any directory.

The script adds a `PreToolUse` hook entry to `~/.claude/settings.json`.

## Step 3 — Start using it

```bash
claude
```

That's it. The bridge runs automatically in the background — no extra commands needed. Whenever Claude reads a file larger than 50k tokens, the hook intercepts the call and routes it through Gemini → Codex before returning the result.

To verify the pipeline is working, open a second terminal and run:

```bash
aitools trace
```

Every time the bridge fires, the trace window shows the data flow within ~100ms.

## Uninstall the bridge

```bash
bash uninstall.sh
```

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

## Testing

No API keys or external services are required — all external calls are mocked.

### Diagnostic check

Quickly verifies that every component is present and functional:

```bash
node test/check.mjs
```

Output example:

```
claude-gemini-codex-bridge — component check

  Runtime
  ✓  Node.js version                  v20.x (>= 18 required)
  ✓  jq                               jq-1.7

  Project files
  ✓  config/defaults.json
  ✓  hooks/pre-tool-use.mjs
  ...

  Module functionality
  ✓  config.mjs                       all sections present
  ✓  paths.mjs                        @ resolution and traversal guard OK
  ✓  router.mjs                       routing logic functional
  ✓  cache.mjs                        cache dir: ~/.claude-gemini-codex-bridge/cache

  External dependencies
  ✗  codex binary                     'codex' not found — required, install: npm install -g @openai/codex
  –  Gemini API connectivity          pass --live to test
```

Add `--live` to also ping the real Gemini API (requires `GEMINI_API_KEY`):

```bash
node test/check.mjs --live
```

### Unit tests

Tests each module in isolation — no network, no filesystem side-effects:

```bash
node --test test/unit.test.mjs
```

| Suite | What is tested |
|---|---|
| `config` | Loads correctly, all sections present, thresholds are valid |
| `logger` | Does not throw, writes to file without crashing |
| `paths` | `@`-notation resolution, path-traversal blocking, per-tool extraction |
| `router` | Small file → approve, large file → delegate, blocked paths, excluded patterns |
| `cache` | Write/read round-trip, key determinism, TTL expiry |

### Integration tests

Simulates the full hook pipeline end-to-end using mocks — no API keys needed:

```bash
node --test test/integration.test.mjs
```

The mock setup:
- A local HTTP server replaces the Gemini API and returns a fixed summary
- A temporary Node.js script replaces the `codex` binary and returns a fixed analysis
- The hook is spawned as a real child process with JSON piped to stdin

| Scenario | What is verified |
|---|---|
| Small file | Hook outputs `{"decision":"approve"}` |
| Unknown tool (`Write`) | Hook passes through without delegating |
| Empty stdin | Hook does not crash |
| Large file (336 KB) | Hook outputs `{"decision":"block"}` with pipeline result |
| Result structure | Output contains both `Gemini Context Summary` and `Codex Analysis` sections |
| Sequential ordering | Gemini section appears before Codex section in the output |
| Cache hit | Second call on same file completes in < 500 ms |
| Codex unavailable | Falls back to Gemini-only result, still returns `block` |
| Gemini CLI missing | Degrades gracefully, returns `approve` instead of crashing |

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

Live tests call the real `gemini` and `codex` binaries and verify:

| Test | What is verified |
|---|---|
| gemini CLI installed | Binary exists in PATH |
| gemini CLI authenticated | Returns a real response to a trivial prompt |
| codex CLI installed | Binary exists in PATH |
| Small file passes through | No delegation for files under threshold |
| Large file triggers pipeline | Real Gemini summary + real Codex analysis returned |
| Result contains both sections | `Gemini Context Summary` and `Codex Analysis` present |
| Gemini summary passed to Codex | Result does not contain raw fixture lines (summarisation verified) |
| Cache hit on second call | Second call completes in < 500ms |
| Codex unavailable | Hook degrades to approve, Claude handles directly (pipeline incomplete) |

These tests take **30–60 seconds** due to real CLI latency.

### Trace: real-time data flow monitor

Run in a separate terminal before using Claude Code:

```bash
aitools trace
```

The script watches the trace directory. Every time the bridge fires,
the result appears automatically within ~100ms — no manual re-running needed.

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

### CI

Tests run automatically on every push and pull request via GitHub Actions across Node.js 18, 20, and 22. See `.github/workflows/test.yml`.

## Project structure

```
claude-gemini-codex-bridge/
├── config/
│   └── defaults.json          # Default configuration values
├── hooks/
│   ├── pre-tool-use.mjs       # Hook entry point (reads stdin, orchestrates pipeline)
│   └── lib/
│       ├── cache.mjs          # SHA-256 content-based cache
│       ├── codex.mjs          # Codex CLI integration
│       ├── config.mjs         # Config loader (defaults + env overrides)
│       ├── gemini.mjs         # Gemini REST API client
│       ├── logger.mjs         # Stderr/file logger (never pollutes stdout)
│       ├── paths.mjs          # @-notation path resolver + file extractor
│       └── router.mjs         # Routing decision engine (token estimation)
├── install.sh
├── uninstall.sh
└── package.json
```

## Credits

Inspired by:
- [tkaufmann/claude-gemini-bridge](https://github.com/tkaufmann/claude-gemini-bridge) — PreToolUse hook pattern, routing logic, caching
- [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) — Codex integration architecture
