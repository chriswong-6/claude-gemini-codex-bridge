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
| `GEMINI_API_KEY` | Google AI Studio key |
| `codex` CLI | `npm install -g @openai/codex` |
| `jq` | for `install.sh` |

## Installation

```bash
git clone https://github.com/YOUR_USERNAME/claude-gemini-codex-bridge
cd claude-gemini-codex-bridge

export GEMINI_API_KEY=your_key_here
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
| `GEMINI_API_KEY` | _(required)_ | Google Gemini API key |
| `GEMINI_MODEL` | `gemini-1.5-pro` | Gemini model to use |
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
| Missing API key | Degrades gracefully, returns `approve` instead of crashing |

### Run everything

```bash
node --test test/unit.test.mjs && node --test test/integration.test.mjs && node test/check.mjs
```

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
