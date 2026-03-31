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
| `gemini` CLI | Google Gemini CLI — auth handled by the CLI, no API key needed |
| `codex` CLI | `npm install -g @openai/codex` — optional, falls back to Gemini-only |
| `jq` | for `install.sh` |

## Installation

```bash
# 1. Install and authenticate the Gemini CLI
#    https://github.com/google-gemini/gemini-cli
gemini auth login

# 2. Install the bridge
git clone https://github.com/chriswong-6/claude-gemini-codex-bridge
cd claude-gemini-codex-bridge
bash install.sh
```

The script adds a `PreToolUse` hook entry to `~/.claude/settings.json`.

## Uninstall

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
  !  codex binary                     'codex' not found — will fallback to Gemini-only
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
| Codex unavailable fallback | Gemini-only result returned when codex binary is missing |

These tests take **30–60 seconds** due to real CLI latency.

### Trace: verify real data flow

After using Claude Code normally with the bridge installed, run:

```bash
aitools trace
```

Shows whether the last real invocation matched the described pipeline.

**Small file (pass-through):**

```
Invocation
  Time   : 31/3/2026, 14:32:05
  Tool   : Read
  Files  : 1
  Reason : ~8k tokens within Claude limit

Described workflow
  Claude ─→ tool call ─→ Claude handles directly

Actual workflow
  ✓ Claude ─→ passed through to Claude

✓  Matches described workflow.
```

**Large file (full pipeline):**

```
Invocation
  Time   : 31/3/2026, 14:35:12
  Tool   : Read
  Files  : 1
  Reason : ~84k tokens exceeds Claude limit

Described workflow
  Claude ─→ Gemini ─→ Codex ─→ result back to Claude

Actual workflow
  Claude ─→ Gemini ✓ ─→ Codex ✓ ─→ result → Claude ✓

  Gemini : ok   1 file(s) → 3241 chars  (12043ms)
  Codex  : ok   3241 chars in → 891 chars out  (8120ms)
  Cache  : miss
  Total  : 20163ms

✓  Matches described workflow.
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
